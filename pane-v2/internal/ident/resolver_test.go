package ident

import (
	"errors"
	"testing"

	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// fakeTmux answers without execing tmux.
type fakeTmux struct {
	inside   bool
	panePids map[string]int
	siblings []Pane
	err      error
}

func (f fakeTmux) Inside() bool { return f.inside }
func (f fakeTmux) PanePid(id string) (int, error) {
	if f.err != nil {
		return 0, f.err
	}
	pid, ok := f.panePids[id]
	if !ok {
		return 0, errors.New("no such pane")
	}
	return pid, nil
}
func (f fakeTmux) SiblingPanes(string) ([]Pane, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.siblings, nil
}

type fakeProcs struct {
	table map[int]int
	err   error
}

func (f fakeProcs) Table() (map[int]int, error) { return f.table, f.err }

type fakeIndex map[int]Entry

func (f fakeIndex) Lookup(pid int) (Entry, bool) { e, ok := f[pid]; return e, ok }

func sess(id string, pid string, cwd string, started int64) relay.Session {
	return relay.Session{ID: id, Pid: pid, Cwd: cwd, StartedAt: relay.Millis(started), Name: id}
}

// The shape on a real machine: tmux pane shell 900 -> zsh 950 -> claude 1000.
var tree = map[int]int{
	900:  1,   // the pane's shell
	950:  900, // a wrapper (just, npm, a login shell)
	1000: 950, // claude, a grandchild
	2000: 1,   // an unrelated claude in another window
	2100: 2000,
}

func TestResolveLadder(t *testing.T) {
	live := []relay.Session{
		sess("aaaa1111-0000", "1000", "/w/repo", 100),
		sess("bbbb2222-0000", "2000", "/w/repo", 200),
	}

	cases := []struct {
		name    string
		cfg     Config
		deps    Deps
		live    []relay.Session
		wantID  string
		wantHow Method
		wantExp string
	}{
		{
			name:    "flag wins outright",
			cfg:     Config{SessionFlag: "bbbb2222-0000"},
			live:    live,
			wantID:  "bbbb2222-0000",
			wantHow: Flag,
		},
		{
			name:    "flag accepts a unique prefix",
			cfg:     Config{SessionFlag: "aaaa"},
			live:    live,
			wantID:  "aaaa1111-0000",
			wantHow: Flag,
		},
		{
			name:    "flag naming an unregistered session waits rather than guessing",
			cfg:     Config{SessionFlag: "cccc3333"},
			live:    live,
			wantHow: None,
			wantExp: "cccc3333",
		},
		{
			name: "pane tree finds a grandchild",
			cfg:  Config{TargetPane: "%0"},
			deps: Deps{
				Tmux:  fakeTmux{inside: true, panePids: map[string]int{"%0": 900}},
				Procs: fakeProcs{table: tree},
			},
			live:    live,
			wantID:  "aaaa1111-0000",
			wantHow: PaneTree,
		},
		{
			name: "an explicit target pid skips tmux entirely",
			cfg:  Config{TargetPid: 900},
			deps: Deps{Procs: fakeProcs{table: tree}},
			live: live, wantID: "aaaa1111-0000", wantHow: PaneTree,
		},
		{
			name: "two claudes in one pane: the newest wins, flagged",
			cfg:  Config{TargetPid: 900},
			deps: Deps{Procs: fakeProcs{table: map[int]int{900: 1, 1000: 900, 1200: 900}}},
			live: []relay.Session{
				sess("old-0000", "1000", "/w/repo", 100),
				sess("new-0000", "1200", "/w/repo", 900),
			},
			wantID: "new-0000", wantHow: Ambiguous,
		},
		{
			name: "sessions index names a session that has not registered yet",
			cfg:  Config{TargetPid: 900},
			deps: Deps{
				Procs: fakeProcs{table: tree},
				Index: fakeIndex{1000: {Pid: 1000, SessionID: "dddd4444", Name: "demo-project"}},
			},
			live:    []relay.Session{sess("zzzz9999", "2000", "/elsewhere", 100)},
			wantHow: None,
			wantExp: "dddd4444",
		},
		{
			name: "sessions index corroborates a session the tree missed",
			cfg:  Config{TargetPid: 900},
			deps: Deps{
				Procs: fakeProcs{table: tree},
				Index: fakeIndex{950: {Pid: 950, SessionID: "aaaa1111-0000"}},
			},
			// The relay reports a pid that is not in the tree, so only the
			// index can connect them.
			live:   []relay.Session{sess("aaaa1111-0000", "7777", "/elsewhere", 100)},
			wantID: "aaaa1111-0000", wantHow: SessionsIndex,
		},
		{
			name: "cwd is unique outside tmux",
			cfg:  Config{Cwd: "/w/only-me"},
			deps: Deps{Tmux: fakeTmux{inside: false}},
			live: []relay.Session{
				sess("aaaa1111-0000", "1000", "/w/only-me", 100),
				sess("bbbb2222-0000", "2000", "/w/other", 200),
			},
			wantID: "aaaa1111-0000", wantHow: Cwd,
		},
		{
			name: "two sessions sharing a cwd is UNPINNED, never a guess",
			cfg:  Config{Cwd: "/w/repo"},
			deps: Deps{Tmux: fakeTmux{inside: false}},
			live: live,
			// This is the real situation on the development machine.
			wantHow: None,
		},
		{
			name:    "nothing to go on at all is UNPINNED",
			cfg:     Config{},
			deps:    Deps{Tmux: fakeTmux{inside: false}},
			live:    live,
			wantHow: None,
		},
		{
			name: "a pid outside the pane tree falls through",
			cfg:  Config{TargetPid: 900, Cwd: "/nowhere"},
			deps: Deps{Procs: fakeProcs{table: tree}},
			live: []relay.Session{sess("bbbb2222-0000", "2000", "/w/repo", 200)},
			// 2000 is not a descendant of 900.
			wantHow: None,
		},
		{
			name: "a ps failure degrades to cwd rather than crashing",
			cfg:  Config{TargetPid: 900, Cwd: "/w/only-me"},
			deps: Deps{Procs: fakeProcs{err: errors.New("ps exploded")}},
			live: []relay.Session{sess("aaaa1111-0000", "1000", "/w/only-me", 100)},
			// The tree is unavailable, so the unique cwd is what is left.
			wantID: "aaaa1111-0000", wantHow: Cwd,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps := tc.deps
			if deps.Tmux == nil {
				deps.Tmux = fakeTmux{}
			}
			if deps.Procs == nil {
				deps.Procs = fakeProcs{}
			}
			r := &PaneResolver{Cfg: tc.cfg, Deps: deps, MaxDepth: 8}
			got := r.Resolve(tc.live)
			if got.ID != tc.wantID {
				t.Errorf("ID = %q, want %q (note: %s)", got.ID, tc.wantID, got.Note)
			}
			if got.How != tc.wantHow {
				t.Errorf("How = %v, want %v (note: %s)", got.How, tc.wantHow, got.Note)
			}
			if got.Expected != tc.wantExp {
				t.Errorf("Expected = %q, want %q", got.Expected, tc.wantExp)
			}
		})
	}
}

func TestSiblingPanesAreWalkedWhenNoTargetIsGiven(t *testing.T) {
	r := &PaneResolver{
		Cfg: Config{SelfPane: "%1"},
		Deps: Deps{
			Tmux:  fakeTmux{inside: true, siblings: []Pane{{ID: "%0", Pid: 900}}},
			Procs: fakeProcs{table: tree},
		},
		MaxDepth: 8,
	}
	got := r.Resolve([]relay.Session{sess("aaaa1111-0000", "1000", "/w/repo", 100)})
	if got.How != PaneTree || got.ID != "aaaa1111-0000" {
		t.Fatalf("got %v %q (%s)", got.How, got.ID, got.Note)
	}
}

func TestDescendantsRespectsDepth(t *testing.T) {
	d := Descendants(tree, []int{900}, 1)
	if !d[950] {
		t.Error("depth 1 must reach the child")
	}
	if d[1000] {
		t.Error("depth 1 must not reach the grandchild")
	}
	d = Descendants(tree, []int{900}, 8)
	if !d[1000] {
		t.Error("depth 8 must reach the grandchild")
	}
	if d[2000] {
		t.Error("an unrelated tree must never be included")
	}
	if len(Descendants(nil, []int{900}, 8)) != 0 {
		t.Error("an empty table yields nothing")
	}
}

func TestParsePSHandlesRealOutput(t *testing.T) {
	got := ParsePS("  900     1\n  950   900\n 1000   950\nbroken line\n")
	if len(got) != 3 || got[1000] != 950 {
		t.Fatalf("ParsePS = %v", got)
	}
}

func TestMethodTags(t *testing.T) {
	// PaneTree is silent: it is the expected case and the header stays clean.
	if PaneTree.Tag() != "" {
		t.Errorf("PaneTree must carry no tag, got %q", PaneTree.Tag())
	}
	for _, m := range []Method{Flag, Ambiguous, SessionsIndex, Cwd, Picked} {
		if m.Tag() == "" {
			t.Errorf("%v must carry a tag so the user can tell how the pane decided", m)
		}
	}
}
