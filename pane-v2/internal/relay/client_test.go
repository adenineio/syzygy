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
			`[{"efforts":[{"title":"Alpha","done":1,"total":4,"claimedBy":[{"id":"s1","name":"one"}]}]}]`+
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
			return
		case <-deadline:
			t.Fatal("no ProjectsMsg arrived: the stream's type switch dropped the projects event")
		}
	}
}
