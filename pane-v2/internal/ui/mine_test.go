package ui

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
)

// contains is a small string-search helper shared by this file's assertions.
func contains(s, sub string) bool { return strings.Contains(s, sub) }

// TestMineShowsOnlyThisSessionsClaims is the core case: two sessions
// each claim a different plan in the same project, and s1's MINE must show
// its own effort and never leak s2's.
func TestMineShowsOnlyThisSessionsClaims(t *testing.T) {
	st := relay.State{Projects: []relay.Project{{
		Efforts: []relay.Effort{
			{Title: "Alpha", Done: 1, Total: 4, ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}}},
			{Title: "Beta", Done: 0, Total: 3, ClaimedBy: []relay.Claimer{{ID: "s2", Name: "two"}}},
		},
	}}}
	out := renderMine(st, "s1")
	if !contains(out, "Alpha") {
		t.Fatalf("own claim missing:\n%s", out)
	}
	if contains(out, "Beta") {
		t.Fatalf("another session's claim leaked in:\n%s", out)
	}
}

// TestMineWithNoClaimsExplainsItself is the empty-state case: a
// session with nothing claimed sees the tool name that fixes it, not a blank
// panel.
func TestMineWithNoClaimsExplainsItself(t *testing.T) {
	out := renderMine(relay.State{}, "s1")
	if !contains(out, "claim_work") {
		t.Fatalf("empty state should name the tool that fixes it:\n%s", out)
	}
}

// TestMineShowsOnlyThisSessionsBacklogSections extends the same filter to
// backlog sections (worktrees[].claimedSections[], resolved onto claimedBy by
// the relay): a section only another session claims must not leak in, and a
// section several sessions claim shows for each of them.
func TestMineShowsOnlyThisSessionsBacklogSections(t *testing.T) {
	st := relay.State{Projects: []relay.Project{{
		Worktrees: []relay.Worktree{{
			ClaimedSections: []relay.ClaimedSection{
				{Text: "Fix the thing", ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}}},
				{Text: "Someone else's section", ClaimedBy: []relay.Claimer{{ID: "s2", Name: "two"}}},
				{Text: "Shared section", ClaimedBy: []relay.Claimer{{ID: "s2", Name: "two"}, {ID: "s1", Name: "one"}}},
			},
		}},
	}}}
	out := renderMine(st, "s1")
	if want := "Fix the thing\nShared section"; out != want {
		t.Fatalf("want exactly this session's sections %q, got:\n%s", want, out)
	}
	if contains(renderMine(st, "s2"), "Fix the thing") {
		t.Fatalf("s1's section leaked into s2's MINE")
	}
}

// decodeProjects decodes a `projects` payload exactly as the stream's
// `projects` case does: a bare JSON array unmarshalled into []relay.Project.
func decodeProjects(t *testing.T, payload string) []relay.Project {
	t.Helper()
	var v []relay.Project
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		t.Fatalf("projects decode: %v", err)
	}
	return v
}

// TestMineReadsClaimedSectionsFromTheWire decodes a worktree line in the shape
// the relay sends and proves MINE reads its claimed sections: this session's
// own heading renders, and a heading only another session claims does not.
func TestMineReadsClaimedSectionsFromTheWire(t *testing.T) {
	projects := decodeProjects(t, `[{"key":"/repo/.git","name":"repo","efforts":[],"moreEfforts":0,`+
		`"worktrees":[{"path":"/repo","branch":"main","head":"abc123","isMain":true,"sessions":[],`+
		`"planCount":1,"taskFile":"TASKS.md","taskAuthority":"TASKS.md",`+
		`"diff":{"only-here":0,"removed":0,"done-here":0,"behind":0},`+
		`"claimedSections":[`+
		`{"rel":"TASKS.md","slug":"fix-the-thing","text":"Fix the thing","claimedBy":[{"id":"s1","name":"one"}]},`+
		`{"rel":"TASKS.md","slug":"someone-elses","text":"Someone else's section","claimedBy":[{"id":"s2","name":"two"}]}`+
		`]}]}]`)
	out := renderMine(relay.State{Projects: projects}, "s1")
	if !contains(out, "Fix the thing") {
		t.Fatalf("own claimed section missing:\n%s", out)
	}
	if contains(out, "Someone else's section") {
		t.Fatalf("another session's section leaked in:\n%s", out)
	}
}

// TestMineWithNoClaimedSectionsKeyShowsNoSections: a worktree line with no
// `claimedSections` key at all, as an older relay sends, decodes to no
// sections and renders none, while a claimed plan beside it still renders.
func TestMineWithNoClaimedSectionsKeyShowsNoSections(t *testing.T) {
	projects := decodeProjects(t, `[{"efforts":[{"title":"Alpha","done":1,"total":4,`+
		`"claimedBy":[{"id":"s1","name":"one"}]}],"worktrees":[{"path":"/repo","branch":"main"}]}]`)
	st := relay.State{Projects: projects}
	efforts, sections := mineClaims(st, "s1")
	if len(sections) != 0 {
		t.Fatalf("a worktree with no claimedSections key yielded sections: %+v", sections)
	}
	if len(efforts) != 1 {
		t.Fatalf("the claimed plan beside it should still render, got %+v", efforts)
	}
	if out := renderMine(st, "s1"); out != "Alpha  1/4" {
		t.Fatalf("want only the plan row, got:\n%s", out)
	}
}

// TestMineMatchesByClaimerIDNotName: matching must go by the claim's session
// id, never by anything
// that merely looks like this session (here, a same-named claimer under a
// different id). A name-based or partial match would show another session's
// work as if it were this session's own.
func TestMineMatchesByClaimerIDNotName(t *testing.T) {
	st := relay.State{Projects: []relay.Project{{
		Efforts: []relay.Effort{
			{Title: "Alpha", Done: 1, Total: 4, ClaimedBy: []relay.Claimer{{ID: "s2", Name: "s1"}}},
		},
	}}}
	out := renderMine(st, "s1")
	if contains(out, "Alpha") {
		t.Fatalf("matched by name/lookalike instead of claimer id:\n%s", out)
	}
}

// TestMineShowsCurrentItem covers MINE's third rendering requirement (plans,
// their current items, and claimed backlog sections). The bridge resolves
// currentItemId to
// text (tasks-efforts.mjs's currentItemText); the pane decodes and shows it,
// never the bare id. A plan with no current step (Beta, done) must render
// with no extra line -- proves the "empty when finished" half, not just the
// "shows one when present" half.
func TestMineShowsCurrentItem(t *testing.T) {
	st := relay.State{Projects: []relay.Project{{
		Efforts: []relay.Effort{
			{
				Title: "Alpha", Done: 1, Total: 4, CurrentItem: "wire the second step",
				ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}},
			},
			{
				Title: "Beta", Done: 3, Total: 3, CurrentItem: "",
				ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}},
			},
		},
	}}}
	out := renderMine(st, "s1")
	if !contains(out, "wire the second step") {
		t.Fatalf("current item text missing:\n%s", out)
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 lines (Alpha, its current item, Beta with none), got %d:\n%s", len(lines), out)
	}
}

// TestMineManyClaimsDoNotOverflowTheFrame: viewMine
// takes only `f Frame`, unlike the other scrollable modes' view functions,
// which all take `budget int` too. Render() applies scrollBody(body, budget)
// unconditionally after body() returns, the same way it does for VITALS and
// GRID (which also return their "natural height" and let the outer call
// window it -- see view.go's body() comment) -- so this proves that holds for
// MINE specifically: many claimed plans and sections, rendered into a frame
// far shorter than the content, must still measure exactly the frame's
// height, and scrolling must reveal what the fixed-height render clipped.
func TestMineManyClaimsDoNotOverflowTheFrame(t *testing.T) {
	var efforts []relay.Effort
	for i := 0; i < 40; i++ {
		efforts = append(efforts, relay.Effort{
			Title: fmt.Sprintf("Plan %02d", i), Done: 1, Total: 4, CurrentItem: fmt.Sprintf("step for plan %02d", i),
			ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}},
		})
	}
	var sections []relay.ClaimedSection
	for i := 0; i < 20; i++ {
		sections = append(sections, relay.ClaimedSection{
			Text:      fmt.Sprintf("Section %02d", i),
			ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}},
		})
	}
	st := relay.State{Sessions: []relay.Session{{ID: "s1"}}, Projects: []relay.Project{{
		Efforts:   efforts,
		Worktrees: []relay.Worktree{{ClaimedSections: sections}},
	}}}

	src := newFakeSource()
	m := New(src, ident.Static{R: ident.Result{ID: "s1", How: ident.PaneTree}}, Config{
		RelayURL: "http://127.0.0.1:4317", Now: func() time.Time { return frozen },
	})
	m.now = frozen
	tm, _ := m.Update(tea.WindowSizeMsg{Width: 41, Height: 20})
	m = tm.(Model)
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(ident.Result{ID: "s1", How: ident.PaneTree}))
	tm, _ = m.setMode(ModeMine)
	m = tm.(Model)

	first := ansi.Strip(m.Render())
	assertFrame(t, m.Render(), 41, 20)
	if !contains(first, "Plan 00") {
		t.Fatalf("first frame should start at the top of the claims:\n%s", first)
	}

	if got := m.maxScroll(m.frame); got <= 0 {
		t.Fatalf("40 plans and 20 sections must overflow a 20-row frame enough to scroll, maxScroll=%d", got)
	}

	tm, _ = m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})
	m = tm.(Model)
	for i := 0; i < 60; i++ {
		tm, _ = m.Update(tea.KeyPressMsg{Code: 'j', Text: "j"})
		m = tm.(Model)
	}
	scrolled := ansi.Strip(m.Render())
	assertFrame(t, m.Render(), 41, 20)
	if contains(scrolled, "Plan 00") {
		t.Fatalf("after scrolling down, the top row should have moved past Plan 00:\n%s", scrolled)
	}
}

// TestMineUpdatesFromAProjectsBroadcast is the headline flow: the relay writes
// a `snapshot` exactly once per SSE connection, so a session that opens the
// pane and THEN runs claim_work is told about it only by the incremental
// `projects` broadcast. Written from SnapshotMsg alone, m.projects would leave
// MINE saying "nothing claimed yet" until the pane reconnected.
func TestMineUpdatesFromAProjectsBroadcast(t *testing.T) {
	src := newFakeSource()
	m := New(src, ident.Static{R: ident.Result{ID: "s1", How: ident.PaneTree}}, Config{
		RelayURL: "http://127.0.0.1:4317", Now: func() time.Time { return frozen },
	})
	m.now = frozen
	tm, _ := m.Update(tea.WindowSizeMsg{Width: 60, Height: 20})
	m = tm.(Model)

	// The single snapshot this connection will ever get: nothing claimed.
	m = feed(t, m, relay.SnapshotMsg(relay.State{Sessions: []relay.Session{{ID: "s1"}}}),
		IdentResult(ident.Result{ID: "s1", How: ident.PaneTree}))
	tm, _ = m.setMode(ModeMine)
	m = tm.(Model)
	if before := ansi.Strip(m.Render()); !contains(before, "claim_work") {
		t.Fatalf("setup: MINE should start on the empty state:\n%s", before)
	}

	// claim_work runs now. The relay's next scan broadcasts `projects`; no
	// second snapshot is ever sent.
	m = feed(t, m, relay.ProjectsMsg([]relay.Project{{Efforts: []relay.Effort{
		{Title: "Alpha", Done: 1, Total: 4, ClaimedBy: []relay.Claimer{{ID: "s1", Name: "one"}}},
	}}}))

	out := ansi.Strip(m.Render())
	if !contains(out, "Alpha") {
		t.Fatalf("a projects broadcast must reach MINE without a reconnect:\n%s", out)
	}
	if contains(out, "claim_work") {
		t.Fatalf("MINE is still on the empty state after a projects broadcast:\n%s", out)
	}
}
