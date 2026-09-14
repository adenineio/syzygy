package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Token is the write credential from ~/.claude/syzygy-relay.json.
// A missing or unreadable file puts the pane in read-only mode rather than
// failing: reads need no auth at all.
type Token struct {
	mu    sync.RWMutex
	path  string
	value string
	port  int
}

type tokenFile struct {
	Token string `json:"token"`
	Port  int    `json:"port"`
}

// DefaultTokenPath is ~/.claude/syzygy-relay.json.
func DefaultTokenPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "syzygy-relay.json")
}

// LoadToken reads the credential file. It never returns an error: an absent
// credential simply means read-only.
func LoadToken(path string) *Token {
	t := &Token{path: path, port: 4317}
	t.Reload()
	return t
}

// Reload re-reads the file, which is what a 401 does once before giving up
// (the credential may have been re-minted by a fresh first session).
func (t *Token) Reload() {
	if t == nil || t.path == "" {
		return
	}
	b, err := os.ReadFile(t.path)
	if err != nil {
		return
	}
	var f tokenFile
	if json.Unmarshal(b, &f) != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if f.Token != "" {
		t.value = f.Token
	}
	if f.Port > 0 {
		t.port = f.Port
	}
}

// Value returns the current credential, empty when read-only.
func (t *Token) Value() string {
	if t == nil {
		return ""
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.value
}

// Port returns the relay port recorded alongside the credential.
func (t *Token) Port() int {
	if t == nil {
		return 4317
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.port <= 0 {
		return 4317
	}
	return t.port
}

// Present reports whether writes are possible.
func (t *Token) Present() bool { return t.Value() != "" }

var postClient = &http.Client{Timeout: 5 * time.Second}

// ErrNoToken is returned when a write is attempted with no credential loaded.
var ErrNoToken = errors.New("read-only: no token in ~/.claude/syzygy-relay.json")

// getBodyCap bounds what one read may pull into the pane. A body past it is
// refused rather than truncated, since a cut JSON body would only fail to
// parse further along with a less useful error.
const getBodyCap = 4 << 20

// Get is the pane's first read beyond the stream, and it exists for one
// reason: the snapshot carries a chain's block titles and states, never its
// summaries or its turn heads, because those would ride every payload for
// every session. A mode that wants the detail asks for exactly the one it is
// showing.
//
// The credential goes on the query string and in the x-mch-token header, since
// the relay's read routes accept either. A 401 reloads the credential file once
// and retries once, as Post does. Any other non-2xx status comes back as the
// status with a nil error, so a caller can tell a 404 from a dead relay.
func (c *Client) Get(ctx context.Context, path string) ([]byte, int, error) {
	if !c.tok.Present() {
		return nil, 0, ErrNoToken
	}
	body, status, err := c.get1(ctx, path)
	if status == http.StatusUnauthorized {
		c.tok.Reload()
		return c.get1(ctx, path)
	}
	return body, status, err
}

func (c *Client) get1(ctx context.Context, path string) ([]byte, int, error) {
	u, err := url.Parse(c.base + path)
	if err != nil {
		return nil, 0, err
	}
	q := u.Query()
	q.Set("token", c.tok.Value())
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("x-mch-token", c.tok.Value())
	resp, err := postClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, getBodyCap+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if len(b) > getBodyCap {
		return nil, resp.StatusCode, fmt.Errorf("read: body over %d bytes", getBodyCap)
	}
	return b, resp.StatusCode, nil
}

// Post performs an authed write. The credential goes in both the body and the
// x-mch-token header, matching the relay's authed(). A 401 reloads the
// credential file once and retries once.
func (c *Client) Post(ctx context.Context, path string, body map[string]any) (int, error) {
	if !c.tok.Present() {
		return 0, ErrNoToken
	}
	status, err := c.post1(ctx, path, body)
	if status == http.StatusUnauthorized {
		c.tok.Reload()
		return c.post1(ctx, path, body)
	}
	return status, err
}

func (c *Client) post1(ctx context.Context, path string, body map[string]any) (int, error) {
	payload := make(map[string]any, len(body)+1)
	for k, v := range body {
		payload[k] = v
	}
	payload["token"] = c.tok.Value()
	buf, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(buf))
	if err != nil {
		return 0, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-mch-token", c.tok.Value())
	resp, err := postClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rb, &e)
		if e.Error == "" {
			e.Error = fmt.Sprintf("http %d", resp.StatusCode)
		}
		return resp.StatusCode, errors.New(e.Error)
	}
	return resp.StatusCode, nil
}
