package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

var readFile = os.ReadFile

// drive feeds raw SSE bytes through the parser, line by line as a reader would.
func drive(raw string) []struct {
	Type string
	Data string
} {
	var out []struct {
		Type string
		Data string
	}
	var evType string
	var data bytes.Buffer
	dispatch := func() {
		if data.Len() > 0 {
			out = append(out, struct {
				Type string
				Data string
			}{evType, data.String()})
		}
		evType, _ = "", 0
		data.Reset()
	}
	for _, line := range strings.SplitAfter(raw, "\n") {
		if line == "" {
			continue
		}
		ParseSSELine([]byte(line), &evType, &data, dispatch)
	}
	return out
}

func TestSSEParserHandlesTheRelaysFrames(t *testing.T) {
	raw := "retry: 1000\n\n" +
		"event: snapshot\ndata: {\"viewers\":1}\n\n" +
		": beat\n\n" +
		"event: sessions\ndata: [{\"id\":\"a\"}]\n\n" +
		"event: dispatch\ndata: {\"requests\":[]}\n\n"
	got := drive(raw)
	if len(got) != 3 {
		t.Fatalf("want 3 dispatched frames, got %d: %+v", len(got), got)
	}
	if got[0].Type != "snapshot" || got[0].Data != `{"viewers":1}` {
		t.Errorf("frame 0 = %+v", got[0])
	}
	if got[1].Type != "sessions" || got[1].Data != `[{"id":"a"}]` {
		t.Errorf("frame 1 = %+v", got[1])
	}
	if got[2].Type != "dispatch" {
		t.Errorf("frame 2 = %+v", got[2])
	}
}

func TestSSEParserJoinsRepeatedDataLines(t *testing.T) {
	got := drive("event: note\ndata: one\ndata: two\n\n")
	if len(got) != 1 || got[0].Data != "one\ntwo" {
		t.Fatalf("repeated data must join with a newline, got %+v", got)
	}
}

func TestSSECommentsDoNotDispatch(t *testing.T) {
	if got := drive(": beat\n\n: beat\n\n"); len(got) != 0 {
		t.Fatalf("heartbeats must not dispatch, got %+v", got)
	}
}

func TestBackoffLadderAndCap(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", nil, nil)
	wants := []time.Duration{
		500 * time.Millisecond, time.Second, 2 * time.Second,
		4 * time.Second, 8 * time.Second, 10 * time.Second, 10 * time.Second,
	}
	for attempt, want := range wants {
		got := c.backoffFor(attempt)
		lo := time.Duration(float64(want) * 0.79)
		hi := time.Duration(float64(want) * 1.21)
		if got < lo || got > hi {
			t.Errorf("attempt %d: backoff %v outside the +/-20%% band around %v", attempt, got, want)
		}
	}
	// Far past the cap it must still be bounded.
	if got := c.backoffFor(40); got > time.Duration(float64(backoffCap)*1.21) {
		t.Errorf("attempt 40: backoff %v exceeds the cap", got)
	}
}

func TestMillisAcceptsNumbersAndStrings(t *testing.T) {
	var v struct {
		A Millis `json:"a"`
		B Millis `json:"b"`
		C Millis `json:"c"`
	}
	if err := json.Unmarshal([]byte(`{"a":1788722779843,"b":"1788722779843","c":null}`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != v.B || v.A == 0 {
		t.Errorf("a=%d b=%d", v.A, v.B)
	}
	if v.C != 0 || !v.C.Time().IsZero() {
		t.Errorf("null millis must stay the zero time")
	}
}

func TestSessionPidAndContextFraction(t *testing.T) {
	s := Session{Pid: "72641", Stats: Stats{Ctx: 745258, CtxLimit: 1_000_000}}
	if s.ParsedPid() != 72641 {
		t.Errorf("ParsedPid = %d", s.ParsedPid())
	}
	if f := s.CtxFrac(); f < 0.745 || f > 0.746 {
		t.Errorf("CtxFrac = %v", f)
	}
	if (Session{Pid: "not-a-number"}).ParsedPid() != 0 {
		t.Error("a non-numeric pid must parse to 0, not panic")
	}
	if (Session{Stats: Stats{Ctx: 5}}).CtxFrac() != 0 {
		t.Error("a zero limit must not divide by zero")
	}
}

func TestDecodeRealSnapshotFixture(t *testing.T) {
	b := mustFixture(t)
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("the recorded live snapshot must decode: %v", err)
	}
	if len(st.Sessions) == 0 || st.Sessions[0].ParsedPid() == 0 {
		t.Fatal("fixture sessions must carry a numeric pid")
	}
	internal := 0
	for _, e := range st.Events {
		if e.Internal {
			internal++
		}
	}
	if internal == 0 {
		t.Fatal("the fixture must contain at least one internal event for the render test to catch")
	}
}

func mustFixture(t *testing.T) []byte {
	t.Helper()
	b, err := readFile("../../testdata/fixtures/snapshot.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return b
}

// TestStreamDeliversProjectsEvent covers the easily-missed hop: the relay
// sends a `snapshot` exactly ONCE per SSE connection and
// then broadcasts `projects` on its own scan cadence, so a claim made after
// the pane connected reaches MINE only through this event. drive() above
// exercises the line parser, not the type switch inside stream(), which is
// where the case was absent -- so this drives a real SSE body end to end.
func TestStreamDeliversProjectsEvent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "event: snapshot\ndata: {\"viewers\":1}\n\n")
		io.WriteString(w, "event: projects\ndata: "+
			`[{"efforts":[{"name":"alpha.md","title":"Alpha","done":1,"total":4,"currentItem":null,"claimedBy":[{"id":"s1","name":"one"}]}],`+
			`"worktrees":[{"path":"/repo","branch":"main","claimedSections":[`+
			`{"rel":"TASKS.md","slug":"fix-the-thing","text":"Fix the thing","claimedBy":[{"id":"s1","name":"one"}]}]}]}]`+
			"\n\n")
	}))
	defer srv.Close()

	c := NewClient(srv.URL, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.stream(ctx)

	deadline := time.After(10 * time.Second)
	for {
		select {
		case m := <-c.Msgs():
			p, ok := m.(ProjectsMsg)
			if !ok {
				continue
			}
			if len(p) != 1 || len(p[0].Efforts) != 1 {
				t.Fatalf("projects payload decoded wrong: %+v", p)
			}
			e := p[0].Efforts[0]
			if e.Title != "Alpha" || e.Done != 1 || e.Total != 4 {
				t.Fatalf("effort decoded wrong: %+v", e)
			}
			if len(e.ClaimedBy) != 1 || e.ClaimedBy[0].ID != "s1" {
				t.Fatalf("claimedBy decoded wrong: %+v", e.ClaimedBy)
			}
			if len(p[0].Worktrees) != 1 || len(p[0].Worktrees[0].ClaimedSections) != 1 {
				t.Fatalf("worktree claimedSections decoded wrong: %+v", p[0].Worktrees)
			}
			cs := p[0].Worktrees[0].ClaimedSections[0]
			if cs.Text != "Fix the thing" || len(cs.ClaimedBy) != 1 || cs.ClaimedBy[0].ID != "s1" {
				t.Fatalf("claimed section decoded wrong: %+v", cs)
			}
			return
		case <-deadline:
			t.Fatal("no ProjectsMsg arrived: the stream's type switch dropped the projects event")
		}
	}
}

// TestStreamDeliversPasteboardEvent drives the wrapped `pasteboard` payload
// through the stream's type switch: a stash made after the pane connected
// reaches PASTE only through this event, and a null sessionId is the global
// board, which must decode to the empty string.
func TestStreamDeliversPasteboardEvent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "event: snapshot\ndata: {\"viewers\":1}\n\n")
		io.WriteString(w, "event: pasteboard\ndata: "+
			`{"pasteboard":[`+
			`{"id":"p1","sessionId":"s1","sessionName":"one","text":"hello\nworld","title":"greet","createdAt":1757600000000,"order":0},`+
			`{"id":"p2","sessionId":null,"sessionName":"","text":"shared","createdAt":1757600000001,"order":0}`+
			`]}`+
			"\n\n")
	}))
	defer srv.Close()

	c := NewClient(srv.URL, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.stream(ctx)

	deadline := time.After(10 * time.Second)
	for {
		select {
		case m := <-c.Msgs():
			p, ok := m.(PasteboardMsg)
			if !ok {
				continue
			}
			if len(p) != 2 {
				t.Fatalf("pasteboard payload decoded wrong: %+v", p)
			}
			if p[0].ID != "p1" || p[0].SessionID != "s1" || p[0].SessionName != "one" ||
				p[0].Text != "hello\nworld" || p[0].Title != "greet" {
				t.Fatalf("session entry decoded wrong: %+v", p[0])
			}
			if p[1].ID != "p2" || p[1].SessionID != "" || p[1].Title != "" {
				t.Fatalf("global entry decoded wrong: %+v", p[1])
			}
			return
		case <-deadline:
			t.Fatal("no PasteboardMsg arrived: the stream's type switch dropped the pasteboard event")
		}
	}
}

// TestStreamDeliversChainEvent covers the same hop as the pasteboard's: the
// snapshot lands once per connection, so a block opened after the pane
// connected arrives only through this event, wrapped with its session id.
func TestStreamDeliversChainEvent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "event: snapshot\ndata: {\"viewers\":1}\n\n")
		io.WriteString(w, "event: chain\ndata: "+
			`{"sessionId":"s1","chain":{"blocks":[`+
			`{"id":"b1","title":"first","state":"closed","by":"heuristic","pinned":false,"parent":null,"turnCount":2,"startedAt":1,"endedAt":2,"rev":1},`+
			`{"id":"b2","title":"second","state":"open","by":"model","pinned":true,"parent":"b0","turnCount":1,"startedAt":2,"endedAt":null,"rev":4}`+
			`],"open":"b2","progress":"going","rev":4,"updatedAt":3,"refiner":{"paused":true}}}`+
			"\n\n")
	}))
	defer srv.Close()

	c := NewClient(srv.URL, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go c.stream(ctx)

	deadline := time.After(10 * time.Second)
	for {
		select {
		case m := <-c.Msgs():
			cm, ok := m.(ChainMsg)
			if !ok {
				continue
			}
			ch := cm.Chain
			if cm.SessionID != "s1" || ch.Rev != 4 || ch.Open != "b2" || !ch.Refiner.Paused || len(ch.Blocks) != 2 {
				t.Fatalf("chain frame decoded wrong: %+v", cm)
			}
			if ch.Blocks[0].Parent != "" || ch.Blocks[1].Parent != "b0" || !ch.Blocks[1].Pinned || ch.Blocks[1].EndedAt != 0 {
				t.Fatalf("chain blocks decoded wrong: %+v", ch.Blocks)
			}
			return
		case <-deadline:
			t.Fatal("no ChainMsg arrived: the stream's type switch dropped the chain event")
		}
	}
}

func tokenAt(t *testing.T, value string) *Token {
	t.Helper()
	p := t.TempDir() + "/relay.json"
	if err := os.WriteFile(p, []byte(`{"token":"`+value+`","port":4999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return LoadToken(p)
}

func TestGetSendsTheTokenBothWaysAndReturnsTheStatusRatherThanAnError(t *testing.T) {
	var gotQuery, gotHeader, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery, gotHeader, gotMethod = r.URL.Query().Get("token"), r.Header.Get("x-mch-token"), r.Method
		if r.URL.Path == "/api/chain/missing" {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `{"error":"unknown session"}`)
			return
		}
		io.WriteString(w, `{"chain":{"blocks":[]}}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, tokenAt(t, "tok-1"), nil)
	body, status, err := c.Get(context.Background(), "/api/chain/s1")
	if err != nil || status != 200 || string(body) != `{"chain":{"blocks":[]}}` {
		t.Fatalf("Get = %q %d %v", body, status, err)
	}
	if gotMethod != http.MethodGet || gotQuery != "tok-1" || gotHeader != "tok-1" {
		t.Errorf("the token must ride the query string and the header: %q %q %q", gotMethod, gotQuery, gotHeader)
	}
	body, status, err = c.Get(context.Background(), "/api/chain/missing")
	if err != nil || status != 404 || !strings.Contains(string(body), "unknown session") {
		t.Errorf("a 404 is a status, not an error: %q %d %v", body, status, err)
	}
}

func TestGetRefusesWithNoToken(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer srv.Close()
	c := NewClient(srv.URL, LoadToken(t.TempDir()+"/absent.json"), nil)
	if _, _, err := c.Get(context.Background(), "/api/chain/s1"); err != ErrNoToken {
		t.Errorf("Get with no credential = %v, want ErrNoToken", err)
	}
	if hit {
		t.Error("a read with no credential reached the relay")
	}
}

func TestGetReloadsTheTokenOnceAfterA401(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"chain":{}}`)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, tokenAt(t, "tok-2"), nil)
	if _, status, err := c.Get(context.Background(), "/api/chain/s1"); err != nil || status != 200 || calls != 2 {
		t.Errorf("a 401 retries once: status %d err %v calls %d", status, err, calls)
	}
}

func TestGetCapsTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, strings.Repeat("x", getBodyCap+16))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, tokenAt(t, "tok-3"), nil)
	body, _, err := c.Get(context.Background(), "/api/chain/s1")
	if err == nil || len(body) > getBodyCap {
		t.Errorf("a body over the cap is refused, not pulled in whole: %d bytes, err %v", len(body), err)
	}
}

func TestDecodeChainDetailReadsOnlyWhatTheModeDraws(t *testing.T) {
	body := `{"chain":{"version":1,"sessionId":"s1","transcript":"/x","rev":7,
		"blocks":[{"id":"b1","title":"first","summary":"what it was about","turns":["t1","t2"],"terms":["a"],"state":"closed"}],
		"turns":{"t1":{"id":"t1","promptHead":"do the thing","answerHead":"did the thing","files":["a.go","b.go"],"at":100,"durationMs":2500,"tools":3},
		         "t2":{"id":"t2","promptHead":"and another","answerHead":"","files":[],"at":200,"durationMs":null}},
		"history":[{"at":50,"rev":6,"blocks":[{"id":"b1","title":"older title","state":"open"}]}],
		"refiner":{"calls":1,"paused":false}}}`
	d, err := DecodeChainDetail([]byte(body))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(d.Blocks) != 1 || d.Blocks[0].Summary != "what it was about" || len(d.Blocks[0].Turns) != 2 {
		t.Errorf("blocks decoded wrong: %+v", d.Blocks)
	}
	t1 := d.Turns["t1"]
	if t1.PromptHead != "do the thing" || t1.AnswerHead != "did the thing" || len(t1.Files) != 2 || t1.At != 100 || t1.DurationMs != 2500 {
		t.Errorf("turn decoded wrong: %+v", t1)
	}
	if len(d.History) != 1 || d.History[0].Rev != 6 || d.History[0].Blocks[0].Title != "older title" {
		t.Errorf("history decoded wrong: %+v", d.History)
	}
	for _, bad := range []string{``, `not json`, `{"error":"unknown session"}`, `{"chain":null}`} {
		if _, err := DecodeChainDetail([]byte(bad)); err == nil {
			t.Errorf("DecodeChainDetail(%q) must fail", bad)
		}
	}
}
