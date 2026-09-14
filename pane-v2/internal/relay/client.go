package relay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"strings"
	"time"
)

// Backoff parameters. 500ms * 2^attempt, capped at 10s, with jitter.
const (
	backoffBase = 500 * time.Millisecond
	backoffCap  = 10 * time.Second
	// Watchdog: three missed 15s heartbeats.
	watchdogIdle = 45 * time.Second
)

// Source is what the UI needs from the relay. The interface exists so tests
// can substitute a channel they own and a Post that records calls.
type Source interface {
	// Msgs is the stream of relay messages. One outstanding read at a time
	// gives natural back-pressure.
	Msgs() <-chan Msg
	// Post performs a token-authed write. Label is echoed back in the result.
	Post(ctx context.Context, path string, body map[string]any) (int, error)
	// Get performs a token-authed read. The body is capped; a non-2xx status
	// is returned rather than an error, so a caller can tell 404 from a dead
	// relay.
	Get(ctx context.Context, path string) ([]byte, int, error)
	// Reconnect drops the current stream and retries immediately.
	Reconnect()
}

// Client is the live SSE source.
type Client struct {
	base   string
	ch     chan Msg
	kick   chan struct{}
	logger *log.Logger
	tok    *Token
	rnd    *rand.Rand
}

// NewClient builds a client against a relay base URL such as
// http://127.0.0.1:4317. It does not connect until Run is called.
func NewClient(base string, tok *Token, logger *log.Logger) *Client {
	return &Client{
		base:   strings.TrimRight(base, "/"),
		ch:     make(chan Msg, 64),
		kick:   make(chan struct{}, 1),
		logger: logger,
		tok:    tok,
		rnd:    rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Msgs implements Source.
func (c *Client) Msgs() <-chan Msg { return c.ch }

// Reconnect implements Source: it asks the run loop to abandon the current
// attempt and try again with the backoff reset.
func (c *Client) Reconnect() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *Client) debugf(format string, args ...any) {
	if c.logger != nil {
		c.logger.Printf(format, args...)
	}
}

// backoffFor returns the delay before attempt n (0-based), with +/-20% jitter.
func (c *Client) backoffFor(attempt int) time.Duration {
	d := backoffBase << attempt
	if d > backoffCap || d <= 0 {
		d = backoffCap
	}
	j := 1 + (c.rnd.Float64()*0.4 - 0.2)
	return time.Duration(float64(d) * j)
}

// Run owns the connection for the life of ctx. It never returns until ctx is
// cancelled: the pane must never exit because the relay is absent.
func (c *Client) Run(ctx context.Context) {
	defer close(c.ch)
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		c.send(ctx, ConnMsg{State: Connecting, Attempt: attempt})
		ok, err := c.stream(ctx)
		if ctx.Err() != nil {
			return
		}
		if ok {
			// The stream carried at least one snapshot, so the next failure
			// starts a fresh backoff ladder.
			attempt = 0
		}
		d := c.backoffFor(attempt)
		c.send(ctx, ConnMsg{State: Down, Attempt: attempt, RetryAt: time.Now().Add(d), Err: err})
		if attempt < 16 {
			attempt++
		}
		select {
		case <-ctx.Done():
			return
		case <-c.kick:
			attempt = 0
		case <-time.After(d):
		}
	}
}

func (c *Client) send(ctx context.Context, m Msg) {
	select {
	case c.ch <- m:
	case <-ctx.Done():
	}
}

// streamClient has no overall Timeout: the SSE body is meant to stay open.
var streamClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
		ResponseHeaderTimeout: 5 * time.Second,
	},
}

// stream opens one SSE connection and pumps it until it fails. It reports
// whether a snapshot was seen, which is what resets the backoff.
func (c *Client) stream(ctx context.Context) (sawSnapshot bool, err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/stream", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	// The relay's auth gate is method-agnostic and gates every GET, this one
	// included, once a pane password is configured: without this the side pane,
	// `just tui2` and hotkey 1 would all 401.
	if c.tok.Present() {
		req.Header.Set("x-mch-token", c.tok.Value())
	}

	resp, err := streamClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("stream: http %d", resp.StatusCode)
	}

	// A manual reconnect abandons the body.
	go func() {
		select {
		case <-ctx.Done():
		case <-c.kick:
			cancel()
		}
	}()

	// Watchdog: any line, including the `: beat` comment, resets it.
	wd := time.NewTimer(watchdogIdle)
	defer wd.Stop()
	go func() {
		select {
		case <-wd.C:
			cancel()
		case <-ctx.Done():
		}
	}()

	// bufio.Reader, not Scanner: a snapshot line (400 events, N x 240 series
	// points, plus every project's scan) blows past Scanner's 64 KiB token limit.
	br := bufio.NewReaderSize(resp.Body, 64*1024)
	var evType string
	var data bytes.Buffer

	dispatch := func() {
		defer func() {
			evType = ""
			data.Reset()
		}()
		if data.Len() == 0 {
			return
		}
		payload := data.Bytes()
		switch evType {
		case "", "message", "snapshot":
			var st State
			if e := json.Unmarshal(payload, &st); e != nil {
				c.debugf("snapshot decode: %v", e)
				return
			}
			sawSnapshot = true
			c.send(ctx, SnapshotMsg(st))
		case "sessions":
			// broadcast('sessions', live()) sends a bare array.
			var v []Session
			if e := json.Unmarshal(payload, &v); e != nil {
				c.debugf("sessions decode: %v", e)
				return
			}
			c.send(ctx, SessionsMsg(v))
		case "projects":
			// broadcast('projects', next) sends a bare array, exactly as
			// `sessions` does. Without this case the payload reached the pane
			// only on the once-per-connection snapshot, so a claim made after
			// the pane connected never showed up in MINE.
			var v []Project
			if e := json.Unmarshal(payload, &v); e != nil {
				c.debugf("projects decode: %v", e)
				return
			}
			c.send(ctx, ProjectsMsg(v))
		case "pasteboard":
			// The one other wrapped payload beside `viewers`:
			// broadcast('pasteboard', { pasteboard: [...] }).
			var w struct {
				Pasteboard []Paste `json:"pasteboard"`
			}
			if e := json.Unmarshal(payload, &w); e != nil {
				c.debugf("pasteboard decode: %v", e)
				return
			}
			c.send(ctx, PasteboardMsg(w.Pasteboard))
		case "chain":
			// Wrapped like `pasteboard`, and per session:
			// broadcast('chain', { sessionId, chain }).
			var v ChainMsg
			if e := json.Unmarshal(payload, &v); e != nil {
				c.debugf("chain decode: %v", e)
				return
			}
			if v.SessionID == "" {
				return
			}
			c.send(ctx, v)
		case "canvas":
			var v Canvas
			if e := json.Unmarshal(payload, &v); e != nil {
				c.debugf("canvas decode: %v", e)
				return
			}
			c.send(ctx, CanvasMsg(v))
		case "events":
			var v []Event
			if e := json.Unmarshal(payload, &v); e != nil {
				c.debugf("events decode: %v", e)
				return
			}
			c.send(ctx, EventsMsg(v))
		case "questions":
			var v []Question
			if e := json.Unmarshal(payload, &v); e != nil {
				return
			}
			c.send(ctx, QuestionsMsg(v))
		case "approvals":
			var v []Approval
			if e := json.Unmarshal(payload, &v); e != nil {
				return
			}
			c.send(ctx, ApprovalsMsg(v))
		case "links":
			var v []Link
			if e := json.Unmarshal(payload, &v); e != nil {
				return
			}
			c.send(ctx, LinksMsg(v))
		case "viewers":
			// The one wrapped payload: broadcast('viewers', { viewers: n }).
			var w struct {
				Viewers int `json:"viewers"`
			}
			if e := json.Unmarshal(payload, &w); e != nil {
				return
			}
			c.send(ctx, ViewersMsg(w.Viewers))
		default:
			// Unknown type: dropped. Never kills the stream.
		}
	}

	for {
		line, rerr := br.ReadBytes('\n')
		if len(line) > 0 {
			wd.Reset(watchdogIdle)
			ParseSSELine(line, &evType, &data, dispatch)
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				return sawSnapshot, errors.New("stream closed")
			}
			if ctx.Err() != nil {
				return sawSnapshot, errors.New("stream cancelled")
			}
			return sawSnapshot, rerr
		}
	}
}

// ParseSSELine feeds one raw line (with or without its trailing newline) into
// the SSE state machine. It is exported so the parser is testable without a
// server.
func ParseSSELine(line []byte, evType *string, data *bytes.Buffer, dispatch func()) {
	s := strings.TrimRight(string(line), "\r\n")
	switch {
	case s == "":
		dispatch()
	case strings.HasPrefix(s, ":"):
		// Comment (the 15s heartbeat). Only resets the watchdog.
	case strings.HasPrefix(s, "event:"):
		*evType = strings.TrimSpace(s[len("event:"):])
	case strings.HasPrefix(s, "data:"):
		v := s[len("data:"):]
		v = strings.TrimPrefix(v, " ")
		if data.Len() > 0 {
			data.WriteByte('\n')
		}
		data.WriteString(v)
	case strings.HasPrefix(s, "retry:"), strings.HasPrefix(s, "id:"):
		// The pane runs its own backoff and the relay sends no ids.
	}
}
