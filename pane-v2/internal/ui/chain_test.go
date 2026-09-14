package ui

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/theme"
)

// chainSummary is long enough that three wrapped rows cannot hold it, and it
// ends on a word that must therefore never be drawn.
const chainSummary = "demo summary: the digit question weighed the leader bank against an eighth tab, " +
	"measured the strip at every width, and settled on nesting the new mode behind the prefix " +
	"so that no caption drops a tier and nothing moves on the strip at all TAILWORD"

// chainDetailBody is GET /api/chain/<id>'s answer for the fixture's chain.
const chainDetailBody = `{"chain":{"rev":3,"blocks":[
 {"id":"demo-b1","title":"demo: read the handoff and the board","summary":"","turns":["t1"]},
 {"id":"demo-b2","title":"demo: drafter prompts for the branches","summary":"","turns":["t2"]},
 {"id":"demo-b3","title":"demo: the digit question","summary":"` + chainSummary + `","turns":["t3","t4"]}],
 "turns":{
  "t3":{"promptHead":"demo: which digit is free","answerHead":"demo: none, so it nests behind the leader","files":["a.go"],"at":1735672000000,"durationMs":4000},
  "t4":{"promptHead":"demo: write the header block","answerHead":"demo: the caption is lit","files":["a.go","b.go"],"at":1735673000000,"durationMs":9000}},
 "history":[
  {"at":1735660000000,"rev":1,"blocks":[{"id":"demo-b1","title":"demo: an older title","state":"open"}]},
  {"at":1735672000000,"rev":3,"blocks":[{"id":"demo-b1","title":"demo: read the handoff and the board","state":"closed"},{"id":"demo-b3","title":"demo: the digit question","state":"open"}]}]}}`

// chainModel is a sized, identified model in CHAIN, reached the way a person
// reaches it: space, then c.
func chainModel(t *testing.T, w, h int) (Model, relay.Session, *fakeSource) {
	t.Helper()
	st := loadFixture(t)
	return chainModelWith(t, w, h, st)
}

func chainModelWith(t *testing.T, w, h int, st relay.State) (Model, relay.Session, *fakeSource) {
	t.Helper()
	self := st.Sessions[0]
	res := ident.Result{ID: self.ID, How: ident.PaneTree}
	m, _ := newModel(t, w, h, res)
	m = feed(t, m, relay.SnapshotMsg(st), IdentResult(res))
	m.toast = Toast{}
	m = pressSpace(t, m)
	m = pressBoard(t, m, "c")
	if m.Mode() != ModeChain {
		t.Fatalf("space c left the pane in %v", m.Mode())
	}
	return m, self, m.src.(*fakeSource)
}

// runCmd runs a command and every command a batch carries, feeding each
// resulting message back through Update, and returns the model.
func runCmd(t *testing.T, m Model, cmd tea.Cmd) Model {
	t.Helper()
	if cmd == nil {
		return m
	}
	msg, ok := settles(t, cmd)
	if !ok || msg == nil {
		return m
	}
	if batch, isBatch := msg.(tea.BatchMsg); isBatch {
		for _, c := range batch {
			m = runCmd(t, m, c)
		}
		return m
	}
	switch msg.(type) {
	case chainDetailMsg, postMsg:
		return feed(t, m, msg)
	}
	return m
}

func chainPlain(m Model) string { return ansi.Strip(m.Render()) }

func TestChainIsTheBanksFirstBuiltModeAndTheStripStaysSeven(t *testing.T) {
	if len(AllModes) != 7 {
		t.Fatalf("AllModes has %d modes, want 7", len(AllModes))
	}
	var c, o *bankEntry
	for i := range ModeBank {
		switch ModeBank[i].Key {
		case "c":
			c = &ModeBank[i]
		case "o":
			o = &ModeBank[i]
		}
	}
	if c == nil || c.Reserved != "" || c.Mode != ModeChain || c.Caption != "CHAIN" {
		t.Errorf("the c row is not CHAIN: %+v", c)
	}
	if o == nil || o.Reserved == "" {
		t.Errorf("the o row must stay reserved: %+v", o)
	}
	if ParseMode("chain") != ModeChain {
		t.Errorf("--mode chain does not select CHAIN")
	}
	if ModeChain.Tiny() != "CHN" || ModeChain.Label() != "CHAIN" || ModeChain.Short() != "CHAIN" {
		t.Errorf("captions = %q %q %q", ModeChain.Label(), ModeChain.Short(), ModeChain.Tiny())
	}
	for _, md := range AllModes {
		if md == ModeChain {
			t.Errorf("CHAIN is on the strip")
		}
	}
}

func TestChainDrawsTheSpineAndTheBranchAtEveryWidth(t *testing.T) {
	for _, sz := range []struct{ w, h int }{{41, 49}, {80, 24}, {30, 20}} {
		m, _, _ := chainModel(t, sz.w, sz.h)
		out := m.Render()
		assertFrame(t, out, sz.w, sz.h)
		assertPaletteOnly(t, out)
		plain := ansi.Strip(out)
		if !strings.Contains(plain, theme.GBoxV) {
			t.Errorf("%dx%d: no spine\n%s", sz.w, sz.h, plain)
		}
		if sz.w >= 41 && !strings.Contains(plain, "demo: the digit question") {
			t.Errorf("%dx%d: the open block's title is missing\n%s", sz.w, sz.h, plain)
		}
		branchRows, flushRows := 0, 0
		for _, ln := range strings.Split(plain, "\n") {
			if strings.Contains(ln, theme.GBranch) {
				branchRows++
				tee := strings.Index(ln, theme.GBoxVR)
				if tee < 0 || tee > strings.Index(ln, theme.GBranch) {
					t.Errorf("%dx%d: the branch row has no tee ahead of its mark: %q", sz.w, sz.h, ln)
				}
			}
			if strings.Contains(ln, "demo: drafter") {
				flushRows++
				if strings.Contains(ln, theme.GBoxVR) {
					t.Errorf("a block whose parent is the row above is not a branch: %q", ln)
				}
			}
		}
		if branchRows != 1 {
			t.Errorf("%dx%d: %d branch rows, want 1\n%s", sz.w, sz.h, branchRows, plain)
		}
		if sz.w >= 41 && flushRows != 1 {
			t.Errorf("%dx%d: the continuation block is not drawn once\n%s", sz.w, sz.h, plain)
		}
	}
}

func TestChainLightsItsCaptionAndNoTab(t *testing.T) {
	m, _, _ := chainModel(t, 41, 49)
	out := m.Render()
	lines := strings.Split(out, "\n")
	if !strings.Contains(ansi.Strip(lines[1]), "CHN") {
		t.Fatalf("the header's second row does not carry CHN: %q", ansi.Strip(lines[1]))
	}
	if n := invertRuns(lines[1]); n != 1 {
		t.Errorf("the tab row has %d lit runs, want only the CHN block", n)
	}
	if n := invertRuns(out); n != 2 {
		t.Errorf("unarmed CHAIN frame has %d reverse-video runs, want the brand and CHN", n)
	}
	m = pressBoard(t, m, "m")
	if n := invertRuns(m.Render()); n != 3 {
		t.Errorf("armed CHAIN frame has %d reverse-video runs, want exactly three", n)
	}
	// The bare ? survives where the block will not fit.
	narrow, _, _ := chainModel(t, 30, 20)
	row := ansi.Strip(strings.Split(narrow.Render(), "\n")[1])
	if !strings.HasSuffix(strings.TrimRight(row, " "), "?") {
		t.Errorf("at 30 columns the tab row must still end in ?: %q", row)
	}
	// A strip mode lights its tab, not a bank caption.
	m = pressBoard(t, m, "3")
	if strings.Contains(ansi.Strip(strings.Split(m.Render(), "\n")[1]), "CHN") {
		t.Errorf("PASTE's tab row carries CHN")
	}
}

func TestChainMergeIsArmedAndOtherKeysCancelIt(t *testing.T) {
	m, self, src := chainModel(t, 41, 49)
	m = pressBoard(t, m, "m")
	if len(src.posts) != 0 {
		t.Fatalf("one m must not write, got %v", src.posts)
	}
	if !m.isArmed("m", "demo-b3") {
		t.Fatalf("m did not arm the block under the cursor (armed %+v)", m.armed)
	}
	if !strings.Contains(chainPlain(m), "MERGE") {
		t.Errorf("the armed strip does not say what m does\n%s", chainPlain(m))
	}
	md, cmd, handled := m.onChainKey(tea.KeyPressMsg{Code: 'm', Text: "m"})
	if !handled || cmd == nil {
		t.Fatalf("the second m did not merge")
	}
	if md.(Model).hasArm {
		t.Errorf("a merge leaves the arm live")
	}
	runCmd(t, md.(Model), cmd)
	if len(src.posts) != 1 || src.posts[0] != "/api/chain/"+self.ID+"/merge" ||
		src.bodies[0]["blockId"] != "demo-b3" || src.bodies[0]["into"] != "prev" {
		t.Errorf("merge posted %v %v", src.posts, src.bodies)
	}

	// Any other key cancels.
	m, _, src = chainModel(t, 41, 49)
	m = pressBoard(t, m, "m")
	m = pressBoard(t, m, "k")
	if m.hasArm || len(src.posts) != 0 {
		t.Errorf("k left the merge armed or wrote")
	}

	// An arm that ran out re-arms rather than merging.
	m, _, src = chainModel(t, 41, 49)
	m = pressBoard(t, m, "m")
	m.now = frozen.Add(armWindow)
	md, cmd, _ = m.onChainKey(tea.KeyPressMsg{Code: 'm', Text: "m"})
	runCmd(t, md.(Model), cmd)
	if len(src.posts) != 0 || !md.(Model).isArmed("m", "demo-b3") {
		t.Errorf("an expired arm merged (%v) or did not re-arm", src.posts)
	}

	// M merges into the NEXT block, which the last block does not have.
	m, _, src = chainModel(t, 41, 49)
	m = pressBoard(t, m, "M")
	if m.hasArm {
		t.Errorf("M armed a merge on the last block")
	}
	m = pressBoard(t, m, "k")
	m = pressBoard(t, m, "M")
	if !m.isArmed("M", "demo-b2") {
		t.Fatalf("M did not arm the block under the cursor")
	}
	_, cmd, _ = m.onChainKey(tea.KeyPressMsg{Code: 'M', Text: "M"})
	runCmd(t, m, cmd)
	if len(src.posts) != 1 || src.bodies[0]["blockId"] != "demo-b2" || src.bodies[0]["into"] != "next" {
		t.Errorf("M posted %v %v", src.posts, src.bodies)
	}
}

func TestChainRebuildIsArmedAndReconnectStaysEverywhereElse(t *testing.T) {
	m, self, src := chainModel(t, 41, 49)
	m = pressBoard(t, m, "R")
	if src.reconnects != 0 {
		t.Errorf("R inside CHAIN reconnected")
	}
	if !m.hasArm || m.armed.Key != "R" || !strings.Contains(m.armed.Label, "discards pins") {
		t.Fatalf("R did not arm a rebuild that says it discards pins: %+v", m.armed)
	}
	_, cmd, _ := m.onChainKey(tea.KeyPressMsg{Code: 'R', Text: "R"})
	runCmd(t, m, cmd)
	if len(src.posts) != 1 || src.posts[0] != "/api/chain/"+self.ID+"/rebuild" {
		t.Errorf("rebuild posted %v", src.posts)
	}
	m = pressBoard(t, m, "3")
	m = pressBoard(t, m, "R")
	if src.reconnects != 1 {
		t.Errorf("R outside CHAIN must still reconnect")
	}
}

func TestChainPinPostsOnceAndPinBackPinsEveryOlderBlock(t *testing.T) {
	m, self, src := chainModel(t, 41, 49)
	md, cmd, handled := m.onChainKey(tea.KeyPressMsg{Code: 'p', Text: "p"})
	if !handled || md.(Model).hasArm {
		t.Fatalf("p is handled and never armed")
	}
	runCmd(t, m, cmd)
	if len(src.posts) != 1 || src.posts[0] != "/api/chain/"+self.ID+"/pin" ||
		src.bodies[0]["blockId"] != "demo-b3" || src.bodies[0]["pinned"] != true {
		t.Fatalf("p posted %v %v", src.posts, src.bodies)
	}
	src.posts, src.bodies = nil, nil
	_, cmd, _ = m.onChainKey(tea.KeyPressMsg{Code: 'P', Text: "P"})
	runCmd(t, m, cmd)
	if len(src.posts) != 2 {
		t.Fatalf("P posted %d times, want one per older block: %v", len(src.posts), src.posts)
	}
	for i, want := range []string{"demo-b1", "demo-b2"} {
		if src.bodies[i]["blockId"] != want || src.bodies[i]["pinned"] != true {
			t.Errorf("P body %d = %v, want %s pinned", i, src.bodies[i], want)
		}
	}
}

func TestChainEnterFetchesTheDetailOncePerRevision(t *testing.T) {
	m, self, src := chainModel(t, 41, 49)
	src.getBody = chainDetailBody
	enter := func(m Model) (Model, tea.Cmd) { return pressKey(t, m, tea.KeyEnter) }

	m, cmd := enter(m)
	if cmd == nil {
		t.Fatalf("enter asked for nothing")
	}
	if !strings.Contains(chainPlain(m), "loading") {
		t.Errorf("before the detail lands the block says it is loading\n%s", chainPlain(m))
	}
	assertFrame(t, m.Render(), 41, 49)
	m, again := enter(m) // collapses while the fetch is in flight
	m, again2 := enter(m)
	if again != nil || again2 != nil {
		t.Errorf("a fetch already in flight for this revision was asked for again")
	}
	m = runCmd(t, m, cmd)
	if len(src.gets) != 1 || src.gets[0] != "/api/chain/"+self.ID {
		t.Fatalf("gets = %v, want exactly one for the session", src.gets)
	}
	plain := chainPlain(m)
	if !strings.Contains(plain, "demo summary") || strings.Contains(plain, "TAILWORD") {
		t.Errorf("the summary is not drawn wrapped to three rows\n%s", plain)
	}
	summaryRows := 0
	for _, ln := range strings.Split(plain, "\n") {
		for _, word := range []string{"demo summary", "measured", "settled", "nesting", "tier"} {
			if strings.Contains(ln, word) {
				summaryRows++
				break
			}
		}
	}
	if summaryRows > 3 {
		t.Errorf("the summary took %d rows, want at most 3", summaryRows)
	}
	if !strings.Contains(plain, "2 files") {
		t.Errorf("the expanded block counts its files once the detail lands\n%s", plain)
	}
	assertFrame(t, m.Render(), 41, 49)

	m, cmd = enter(m) // collapse
	m, cmd2 := enter(m)
	if cmd != nil || cmd2 != nil || len(src.gets) != 1 {
		t.Errorf("a second enter on the same revision fetched again: %v", src.gets)
	}

	// A new revision makes the next expansion fetch again.
	st := loadFixture(t)
	ch := st.Chains[self.ID]
	ch.Rev = 4
	m = feed(t, m, relay.ChainMsg{SessionID: self.ID, Chain: ch})
	m, _ = enter(m) // collapse
	m, cmd = enter(m)
	if cmd == nil {
		t.Fatalf("a higher rev did not refetch")
	}
	m = runCmd(t, m, cmd)
	if len(src.gets) != 2 {
		t.Errorf("gets = %v, want a second fetch for rev 4", src.gets)
	}

	// A reply for an older revision than the one held is dropped.
	m = feed(t, m, chainDetailMsg{sessionID: self.ID, rev: 3, detail: relay.ChainDetail{
		Blocks: []relay.ChainDetailBlock{{ID: "demo-b3", Summary: "stale summary"}},
	}})
	if strings.Contains(chainPlain(m), "stale summary") {
		t.Errorf("a reply older than the held detail replaced it")
	}

	// The full view marks the answer excerpt as the end of the answer.
	m = pressBoard(t, m, "E")
	full := chainPlain(m)
	if !strings.Contains(full, "…demo: none, so it nests") {
		t.Errorf("the answer excerpt is not marked as a tail\n%s", full)
	}
	assertFrame(t, m.Render(), 41, 49)
}

func TestChainDetailFailuresKeepTheCompactChain(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		status int
		err    error
	}{
		{"404", `{"error":"unknown session"}`, 404, nil},
		{"500", ``, 500, nil},
		{"unparseable", `not json at all`, 200, nil},
		{"no chain", `{}`, 200, nil},
		{"dead relay", ``, 0, errors.New("connection refused")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, _, src := chainModel(t, 41, 49)
			src.getBody, src.getStatus, src.getErr = c.body, c.status, c.err
			m, cmd := pressKey(t, m, tea.KeyEnter)
			m = runCmd(t, m, cmd)
			out := m.Render()
			assertFrame(t, out, 41, 49)
			plain := ansi.Strip(out)
			if !strings.Contains(plain, "could not be read") {
				t.Errorf("a failed read does not say so\n%s", plain)
			}
			if !strings.Contains(plain, "demo: the digit question") || !strings.Contains(plain, theme.GBoxV) {
				t.Errorf("a failed read blanked the compact chain\n%s", plain)
			}
		})
	}
}

func TestChainHistoryScrubsRevisions(t *testing.T) {
	m, _, src := chainModel(t, 41, 49)
	src.getBody = chainDetailBody
	m, cmd := pressKey(t, m, tea.KeyEnter)
	m = runCmd(t, m, cmd)

	m = pressBoard(t, m, "t")
	if !strings.Contains(chainPlain(m), "rev 3") {
		t.Fatalf("history starts on the newest revision\n%s", chainPlain(m))
	}
	m = pressBoard(t, m, "h")
	plain := chainPlain(m)
	if !strings.Contains(plain, "rev 1") || !strings.Contains(plain, "demo: an older title") {
		t.Errorf("h does not step back a revision\n%s", plain)
	}
	assertFrame(t, m.Render(), 41, 49)
	m = pressBoard(t, m, "h")
	if !strings.Contains(chainPlain(m), "rev 1") {
		t.Errorf("h past the oldest revision must hold on it")
	}
	m = pressBoard(t, m, "l")
	if !strings.Contains(chainPlain(m), "rev 3") {
		t.Errorf("l does not step forward")
	}
	m, _ = pressKey(t, m, tea.KeyEscape)
	if strings.Contains(chainPlain(m), "rev 3") || m.Mode() != ModeChain {
		t.Errorf("esc leaves history and stays in CHAIN\n%s", chainPlain(m))
	}

	// With no revisions the mode says so.
	m, _, src = chainModel(t, 41, 49)
	src.getBody = `{"chain":{"blocks":[],"turns":{},"history":[]}}`
	m, cmd = pressKey(t, m, tea.KeyEnter)
	m = runCmd(t, m, cmd)
	m = pressBoard(t, m, "t")
	if !strings.Contains(chainPlain(m), "no revisions") {
		t.Errorf("an empty history is drawn blank\n%s", chainPlain(m))
	}

	// With no detail fetched yet the mode says so too.
	m, _, _ = chainModel(t, 41, 49)
	m = pressBoard(t, m, "t")
	plain = chainPlain(m)
	if !strings.Contains(plain, "history") || !strings.Contains(plain, "loading") {
		t.Errorf("history with no detail yet does not say so\n%s", plain)
	}
	assertFrame(t, m.Render(), 41, 49)
}

func TestChainOnARelayThatPredatesChains(t *testing.T) {
	st := loadFixture(t)
	st.Chains = nil
	m, _, src := chainModelWith(t, 41, 49, st)
	if !strings.Contains(chainPlain(m), "relay predates chains") {
		t.Fatalf("a nil chains map is not called out\n%s", chainPlain(m))
	}
	for _, k := range []string{"j", "k", "J", "K", "p", "P", "m", "M", "s", "r", "R", "t", "h", "l", "E"} {
		md, cmd, _ := m.onChainKey(tea.KeyPressMsg{Code: []rune(k)[0], Text: k})
		runCmd(t, md.(Model), cmd)
	}
	_, cmd := pressKey(t, m, tea.KeyEnter)
	runCmd(t, m, cmd)
	if len(src.posts) != 0 || len(src.gets) != 0 {
		t.Errorf("keys on a relay with no chains wrote %v or read %v", src.posts, src.gets)
	}
	assertFrame(t, m.Render(), 41, 49)
}

func TestChainWithNoBlocksSaysWhatFillsIt(t *testing.T) {
	st := loadFixture(t)
	st.Chains = map[string]relay.Chain{st.Sessions[0].ID: {}}
	m, _, _ := chainModelWith(t, 41, 49, st)
	if !strings.Contains(chainPlain(m), "finished turn") {
		t.Errorf("an empty chain does not say what fills it\n%s", chainPlain(m))
	}
	assertFrame(t, m.Render(), 41, 49)

	st.Chains = map[string]relay.Chain{"someone-else": {}}
	m, _, _ = chainModelWith(t, 41, 49, st)
	if !strings.Contains(chainPlain(m), "finished turn") {
		t.Errorf("a session with no chain yet does not say what fills it\n%s", chainPlain(m))
	}
}

func TestChainSaysTheRefinerIsPaused(t *testing.T) {
	st := loadFixture(t)
	ch := st.Chains[st.Sessions[0].ID]
	ch.Refiner.Paused = true
	st.Chains = map[string]relay.Chain{st.Sessions[0].ID: ch}
	m, _, _ := chainModelWith(t, 41, 49, st)
	lines := strings.Split(chainPlain(m), "\n")
	if !strings.Contains(lines[len(lines)-1], "refiner paused") {
		t.Errorf("the last row does not say the refiner is paused: %q", lines[len(lines)-1])
	}
}

func TestChainEventReplacesOneSessionsChain(t *testing.T) {
	m, self, _ := chainModel(t, 41, 49)
	m = feed(t, m, relay.ChainMsg{SessionID: "someone-else", Chain: relay.Chain{
		Blocks: []relay.ChainBlock{{ID: "x1", Title: "demo: not this session", State: "open"}},
	}})
	if strings.Contains(chainPlain(m), "not this session") {
		t.Errorf("another session's chain was drawn")
	}
	m = feed(t, m, relay.ChainMsg{SessionID: self.ID, Chain: relay.Chain{Rev: 9, Open: "n2", Blocks: []relay.ChainBlock{
		{ID: "n1", Title: "demo: a merged block", State: "merged"},
		{ID: "n2", Title: "demo: the new topic", State: "open"},
	}}})
	plain := chainPlain(m)
	if !strings.Contains(plain, "demo: the new topic") || strings.Contains(plain, "demo: the digit question") {
		t.Errorf("the chain event did not replace this session's chain\n%s", plain)
	}
	if strings.Contains(plain, "demo: a merged block") {
		t.Errorf("a merged block is drawn")
	}
}

func TestChainBranchJumpsAndSplitNeedsATurn(t *testing.T) {
	st := loadFixture(t)
	self := st.Sessions[0]
	st.Chains = map[string]relay.Chain{self.ID: {Rev: 3, Blocks: []relay.ChainBlock{
		{ID: "a", Title: "demo: a", State: "closed"},
		{ID: "b", Title: "demo: b", State: "closed", Parent: "x"},
		{ID: "c", Title: "demo: c", State: "closed", Parent: "b"},
		{ID: "d", Title: "demo: d", State: "open", Parent: "a"},
	}}}
	m, _, src := chainModelWith(t, 41, 49, st)
	if m.chCursor() != "d" {
		t.Fatalf("the cursor starts on the newest block, got %q", m.chCursor())
	}
	m = pressBoard(t, m, "K")
	if m.chCursor() != "b" {
		t.Errorf("K jumps to the previous branch, got %q", m.chCursor())
	}
	m = pressBoard(t, m, "J")
	if m.chCursor() != "d" {
		t.Errorf("J jumps to the next branch, got %q", m.chCursor())
	}

	// s outside the full view arms nothing.
	m = pressBoard(t, m, "s")
	if m.hasArm || len(src.posts) != 0 {
		t.Errorf("s outside a block's turns armed or wrote")
	}

	// Inside it, s splits at the turn under the cursor.
	src.getBody = `{"chain":{"blocks":[{"id":"d","title":"demo: d","summary":"","turns":["u1","u2"]}],
		"turns":{"u1":{"promptHead":"demo: one"},"u2":{"promptHead":"demo: two"}},"history":[]}}`
	tm, cmd := m.Update(tea.KeyPressMsg{Code: 'E', Text: "E"})
	m = tm.(Model)
	m.now = frozen
	m = runCmd(t, m, cmd)
	if !m.ch.full {
		t.Fatalf("E did not open the full view")
	}
	m = pressBoard(t, m, "j")
	m = pressBoard(t, m, "s")
	if !m.hasArm || m.armed.Key != "s" {
		t.Fatalf("s did not arm a split: %+v", m.armed)
	}
	_, cmd, _ = m.onChainKey(tea.KeyPressMsg{Code: 's', Text: "s"})
	runCmd(t, m, cmd)
	if len(src.posts) != 1 || src.posts[0] != "/api/chain/"+self.ID+"/split" ||
		src.bodies[0]["blockId"] != "d" || src.bodies[0]["atTurnId"] != "u2" {
		t.Errorf("split posted %v %v", src.posts, src.bodies)
	}
}

func TestChainRefineToastsTheRelaysRefusal(t *testing.T) {
	m, self, src := chainModel(t, 41, 49)
	src.postErr = errors.New("already refining")
	md, cmd, _ := m.onChainKey(tea.KeyPressMsg{Code: 'r', Text: "r"})
	m = runCmd(t, md.(Model), cmd)
	if len(src.posts) != 1 || src.posts[0] != "/api/chain/"+self.ID+"/refine" {
		t.Fatalf("r posted %v", src.posts)
	}
	if !strings.Contains(chainPlain(m), "already refining") {
		t.Errorf("the relay's refusal is not toasted\n%s", chainPlain(m))
	}
}
