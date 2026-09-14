package relay

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"testing"
)

// tagsOf is the set of json tag names a struct actually decodes.
func tagsOf(v any) map[string]bool {
	out := map[string]bool{}
	t := reflect.TypeOf(v)
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		for j := 0; j < len(tag); j++ {
			if tag[j] == ',' {
				tag = tag[:j]
				break
			}
		}
		if tag != "" && tag != "-" {
			out[tag] = true
		}
	}
	return out
}

func fixtureMap(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("../../testdata/fixtures/snapshot.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("fixture decode: %v", err)
	}
	return m
}

// ignoredTopLevel names every payload key the pane deliberately does not
// decode, and why. A key in neither this map nor State's json tags fails.
var ignoredTopLevel = map[string]string{}

// ignoredSessionFields names every session field the pane deliberately does not
// decode, and why. A field in neither this map nor Session's json tags fails.
var ignoredSessionFields = map[string]string{
	"transcript": "the path to a session's own transcript, which only the relay reads",
}

func TestChainsDecodeFromTheFixture(t *testing.T) {
	b, err := os.ReadFile("../../testdata/fixtures/snapshot.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.Chains == nil {
		t.Fatal("chains did not decode")
	}
	ch, ok := st.Chains[st.Sessions[0].ID]
	if !ok {
		t.Fatalf("no chain for the first session: %+v", st.Chains)
	}
	if len(ch.Blocks) != 3 || ch.Rev == 0 || ch.UpdatedAt == 0 || ch.Progress == "" {
		t.Fatalf("chain did not decode: %+v", ch)
	}
	open, branch := false, false
	for i, blk := range ch.Blocks {
		if blk.State == "open" && blk.ID == ch.Open {
			open = true
			if blk.EndedAt != 0 {
				t.Errorf("the open block's null endedAt decodes to zero, got %d", blk.EndedAt)
			}
		}
		if i > 0 && blk.Parent != "" && blk.Parent != ch.Blocks[i-1].ID {
			branch = true
		}
	}
	if !open || !branch {
		t.Errorf("the fixture needs an open block (%v) and a branch (%v)", open, branch)
	}
	if ch.Blocks[0].Parent != "" || !ch.Blocks[0].Pinned || ch.Blocks[0].TurnCount == 0 {
		t.Errorf("a null parent decodes to empty and the flags decode: %+v", ch.Blocks[0])
	}
}

func TestEveryTopLevelKeyIsDecodedOrDeclaredIgnored(t *testing.T) {
	decoded := tagsOf(State{})
	for key := range fixtureMap(t) {
		if decoded[key] {
			continue
		}
		if why, ok := ignoredTopLevel[key]; ok && why != "" {
			continue
		}
		t.Errorf("payload key %q is neither decoded by State nor declared in ignoredTopLevel", key)
	}
}

func TestEverySessionAndCanvasFieldIsDecoded(t *testing.T) {
	fix := fixtureMap(t)
	var sessions []map[string]json.RawMessage
	if err := json.Unmarshal(fix["sessions"], &sessions); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	sd := tagsOf(Session{})
	for key := range sessions[0] {
		if sd[key] {
			continue
		}
		if why, ok := ignoredSessionFields[key]; ok && why != "" {
			continue
		}
		t.Errorf("session field %q is neither decoded by Session nor declared in ignoredSessionFields", key)
	}
	// A ledger entry for a field Session now decodes is a stale excuse.
	for key := range ignoredSessionFields {
		if sd[key] {
			t.Errorf("session field %q is decoded by Session and still declared ignored", key)
		}
	}
	var canvas map[string]json.RawMessage
	if err := json.Unmarshal(fix["canvas"], &canvas); err != nil {
		t.Fatalf("canvas: %v", err)
	}
	cd := tagsOf(Canvas{})
	for key := range canvas {
		if !cd[key] {
			t.Errorf("canvas field %q is not decoded by Canvas", key)
		}
	}
}

// The reverse of the keys ledger: a field on State with no fixture key would
// pass that ledger vacuously, so the fixture must carry every key State reads.
func TestEveryDecodedKeyIsInTheFixture(t *testing.T) {
	fix := fixtureMap(t)
	for key := range tagsOf(State{}) {
		if _, ok := fix[key]; !ok {
			t.Errorf("State decodes %q but the fixture has no such key", key)
		}
	}
}

// The fixture never claims a payload newer than the relay beside it. Equality
// is deliberately not asserted: the relay bumps its version by hand on every
// payload change, and a pinned number here would fail on each of those merges.
// A checkout without the bridge skips rather than failing.
func TestTheFixtureIsNoNewerThanTheRelay(t *testing.T) {
	b, err := os.ReadFile("../../../syzygy/bridge/relay.mjs")
	if err != nil {
		t.Skip("no bridge in this checkout")
	}
	m := regexp.MustCompile(`PAYLOAD_VERSION\s*=\s*(\d+)`).FindSubmatch(b)
	if m == nil {
		t.Fatal("no PAYLOAD_VERSION in the bridge")
	}
	want, err := strconv.Atoi(string(m[1]))
	if err != nil {
		t.Fatalf("unparseable PAYLOAD_VERSION: %v", err)
	}
	var fix struct {
		PayloadVersion int `json:"payloadVersion"`
	}
	b2, err := os.ReadFile("../../testdata/fixtures/snapshot.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if err := json.Unmarshal(b2, &fix); err != nil {
		t.Fatalf("fixture decode: %v", err)
	}
	if fix.PayloadVersion == 0 {
		t.Fatal("the fixture carries no payloadVersion")
	}
	if fix.PayloadVersion > want {
		t.Fatalf("fixture payloadVersion %d is newer than the relay's %d", fix.PayloadVersion, want)
	}
}

func TestCanvasDecodesFromTheFixture(t *testing.T) {
	b, _ := os.ReadFile("../../testdata/fixtures/snapshot.json")
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.PayloadVersion == 0 {
		t.Error("payloadVersion did not decode")
	}
	if st.Canvas.Live != 1 || st.Canvas.Home == "" || len(st.Canvas.Nodes) != 1 {
		t.Errorf("canvas did not decode: %+v", st.Canvas)
	}
	s := st.Sessions[0]
	if !s.Waiting || s.WaitingFor == "" || s.Kind != "background" || s.ShortID == "" ||
		s.Jump != "tmux" || s.Color == "" || s.Tmux == "" || s.LastAnswer == "" || s.Root == "" {
		t.Errorf("session fields did not decode: %+v", s)
	}
}

func TestNeedsNowPrefersTheObservationOverTheInference(t *testing.T) {
	cases := []struct {
		name string
		s    Session
		want string
	}{
		{"nothing", Session{}, ""},
		{"only the plugin's read", Session{Needs: "a decision"}, "a decision"},
		{"waiting outranks it", Session{Waiting: true, WaitingFor: "a permission", Needs: "a decision"}, "a permission"},
		{"waiting with no reason still says so", Session{Waiting: true, Needs: "a decision"}, "waiting for input"},
	}
	for _, c := range cases {
		if got := c.s.NeedsNow(); got != c.want {
			t.Errorf("%s: NeedsNow() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestKillPlanNamesTheMechanism(t *testing.T) {
	bg := Session{Kind: "background", ShortID: "a5eb", Pid: "72641"}
	mode, what, can := bg.KillPlan()
	if !can || mode != "stop" || what != "claude stop a5eb" {
		t.Errorf("a background session stops: %q %q %v", mode, what, can)
	}
	inter := Session{Pid: "72641"}
	mode, what, can = inter.KillPlan()
	if !can || mode != "signal" || what != "SIGTERM to pid 72641" {
		t.Errorf("an interactive session is signalled: %q %q %v", mode, what, can)
	}
	none := Session{Pid: "0"}
	if _, _, can = none.KillPlan(); can {
		t.Error("a session with no pid and no short id cannot be closed")
	}
}
