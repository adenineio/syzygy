package hotkeys

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shipped is the file the plugin's installer writes, trimmed to three slots.
// It carries everything a save must not lose: a `_readme` FIRST, a `settings`
// object with a key this package has never heard of (`spinner`, which another
// agent is adding to the band right now), and a stub slot with an empty
// prompt.
const shipped = `{
  "_readme": [
    "Syzygy HUD config. Pressing a hotkey submits its prompt into the session.",
    "An entry with an empty prompt is hidden, so the stubs below are templates."
  ],
  "settings": {
    "spinnerPicker": false,
    "pieStyle": "moon",
    "spinner": "relic"
  },
  "hotkeys": [
    {"key": "2", "title": "my next steps", "short": "next", "prompt": "what next?"},
    {"key": "3", "title": "step back", "short": "back", "prompt": "step back"},
    {"key": "5", "title": "", "short": "", "prompt": ""}
  ]
}`

func parse(t *testing.T, s string) *File {
	t.Helper()
	f, err := Parse([]byte(s))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return f
}

func slotOf(t *testing.T, slots []Slot, key string) Slot {
	t.Helper()
	for _, s := range slots {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("slot %q is missing from the merged view", key)
	return Slot{}
}

// TestMergeIsWhatTheBandWouldSee is the mode's whole premise: the list it
// edits must be the list the band renders, or the editor is showing a
// different file from the one in force. Global slots, with the project's
// written over them one slot at a time -- never whole-file, which is what lets
// a project claim one hotkey without restating the seven it does not care
// about.
func TestMergeIsWhatTheBandWouldSee(t *testing.T) {
	global := parse(t, shipped)
	project := parse(t, `{"hotkeys":[{"key":"3","title":"run tests","short":"test","prompt":"just verify"}]}`)

	slots := Merge(global, project)
	if len(slots) != len(SlotKeys) {
		t.Fatalf("the merged view must hold all eight slots, got %d", len(slots))
	}
	for i, s := range slots {
		if s.Key != SlotKeys[i] {
			t.Fatalf("slot %d is %q, want %q -- the band's display order is not sorted order", i, s.Key, SlotKeys[i])
		}
	}

	// Untouched by the project: the global value stands.
	if got := slotOf(t, slots, "2"); got.Live().Prompt != "what next?" || got.InProject {
		t.Fatalf("slot 2 should be inherited whole from global, got %+v", got)
	}
	// Claimed by the project: its value wins, and only its slot changed.
	three := slotOf(t, slots, "3")
	if three.Live().Prompt != "just verify" || three.Live().Title != "run tests" || !three.InProject {
		t.Fatalf("slot 3 should carry the project's value, got %+v", three)
	}
	// The global entry is still remembered under it: a GLOBAL row has to show
	// the global file's own text even while a project is overriding it.
	if three.Global.Prompt != "step back" {
		t.Fatalf("the global entry was overwritten by the merge, got %+v", three.Global)
	}
	if !three.InGlobal {
		t.Fatal("slot 3 is named by both files; the merge must remember the global one named it too")
	}
	// Named by neither: still present in the list, still empty.
	if got := slotOf(t, slots, "9"); got.InGlobal || got.InProject || !got.Hidden() {
		t.Fatalf("slot 9 is in no file and must read as empty, got %+v", got)
	}
}

// TestEmptyPromptHidesASlot is the format's one non-obvious rule: an entry
// with an empty prompt is OFF, which is the only way to say "not here" in a
// file where absence already means "inherit". A project that empties a slot
// the global file filled must turn it off, not fall back to the global value.
func TestEmptyPromptHidesASlot(t *testing.T) {
	global := parse(t, shipped)
	project := parse(t, `{"hotkeys":[{"key":"2","title":"my next steps","short":"next","prompt":""}]}`)

	two := slotOf(t, Merge(global, project), "2")
	if !two.Hidden() {
		t.Fatalf("an empty prompt in the project file must hide slot 2, got %+v", two)
	}
	if two.Live().Prompt == "what next?" {
		t.Fatal("the project's empty prompt fell back to the global value; that makes a slot impossible to turn off")
	}

	// A stub the global file ships with (slot 5: all three fields empty) is
	// hidden for the same reason, and a title with no prompt is too -- the
	// band renders a slot only when it has both.
	if !slotOf(t, Merge(global, nil), "5").Hidden() {
		t.Fatal("an all-empty stub slot must be hidden")
	}
	titled := parse(t, `{"hotkeys":[{"key":"6","title":"titled","short":"t","prompt":""}]}`)
	if !slotOf(t, Merge(titled, nil), "6").Hidden() {
		t.Fatal("a slot with a title but no prompt must still be hidden: the band needs both")
	}
}

// TestBadgesNameWhereAValueCameFrom covers the four states a row can be in,
// in both scopes. The badge is the only thing on the row that distinguishes
// "this project set it" from "this is the global one showing through", and
// getting it wrong would have the user editing a file they are not looking at.
func TestBadgesNameWhereAValueCameFrom(t *testing.T) {
	global := parse(t, shipped)
	project := parse(t, `{"hotkeys":[
		{"key":"3","title":"run tests","short":"test","prompt":"just verify"},
		{"key":"2","title":"my next steps","short":"next","prompt":""}
	]}`)
	slots := Merge(global, project)

	cases := []struct {
		key, project, global string
	}{
		// set in global only, live: inherited here, unbadged there
		{"7", "unset", "unset"},
		{"3", "set here", ""},
		{"2", "hidden", ""},
		{"5", "unset", "hidden"},
	}
	for _, c := range cases {
		s := slotOf(t, slots, c.key)
		if got := Badge(s, Project); got != c.project {
			t.Errorf("slot %s in PROJECT: badge %q, want %q (%+v)", c.key, got, c.project, s)
		}
		if got := Badge(s, Global); got != c.global {
			t.Errorf("slot %s in GLOBAL: badge %q, want %q (%+v)", c.key, got, c.global, s)
		}
	}
	// The headline case: global fills it, the project says nothing.
	if got := Badge(slotOf(t, slots, "2"), Project); got == "inherited" {
		t.Fatal("a slot the project explicitly emptied must not read as inherited")
	}
	unclaimed := Merge(global, nil)
	if got := Badge(slotOf(t, unclaimed, "2"), Project); got != "inherited" {
		t.Fatalf("a live global slot the project does not name reads %q, want inherited", got)
	}
}

// TestSaveKeepsEverythingItDidNotEdit is the rule that makes this editor safe
// to point at a hand-maintained file: `settings` (including a key this package
// has never heard of), `_readme`, unknown top-level fields and unknown fields
// on the entry itself all survive, and `_readme` stays FIRST rather than being
// shuffled to wherever a Go map would sort it.
func TestSaveKeepsEverythingItDidNotEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	src := strings.Replace(shipped,
		`{"key": "2", "title": "my next steps", "short": "next", "prompt": "what next?"}`,
		`{"key": "2", "title": "my next steps", "short": "next", "prompt": "what next?", "note": "mine"}`, 1)
	src = strings.Replace(src, `"_readme": [`, `"futureKey": {"a": 1},
  "_readme": [`, 1)
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := SaveSlot(path, Entry{Key: "2", Title: "planned", Short: "plan", Prompt: "write the plan"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(b)

	var doc struct {
		Readme    []string       `json:"_readme"`
		Settings  map[string]any `json:"settings"`
		FutureKey map[string]any `json:"futureKey"`
		Hotkeys   []struct {
			Key, Title, Short, Prompt, Note string
		} `json:"hotkeys"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("the saved file does not parse: %v\n%s", err, out)
	}
	if len(doc.Readme) != 2 {
		t.Fatalf("_readme was lost: %#v", doc.Readme)
	}
	if doc.Settings["spinner"] != "relic" || doc.Settings["pieStyle"] != "moon" {
		t.Fatalf("settings lost a key this package does not know about: %#v", doc.Settings)
	}
	if doc.FutureKey == nil {
		t.Fatal("an unknown top-level key was dropped")
	}
	if len(doc.Hotkeys) != 3 {
		t.Fatalf("the hotkeys array changed shape: %d entries", len(doc.Hotkeys))
	}
	if doc.Hotkeys[0].Prompt != "write the plan" || doc.Hotkeys[0].Title != "planned" {
		t.Fatalf("slot 2 was not written: %+v", doc.Hotkeys[0])
	}
	if doc.Hotkeys[0].Note != "mine" {
		t.Fatal("an unknown field on the edited entry was dropped")
	}
	if doc.Hotkeys[1].Prompt != "step back" {
		t.Fatal("editing slot 2 changed slot 3")
	}
	// Key order: a save that moved the readme to the bottom would make every
	// diff of this file unreadable.
	if i, j := strings.Index(out, `"_readme"`), strings.Index(out, `"hotkeys"`); i < 0 || i > j {
		t.Fatalf("_readme did not stay ahead of hotkeys:\n%s", out)
	}
}

// TestSavingANewSlotOnlyAddsThatSlot is how a PROJECT file is born: the file
// does not exist, and the first save must write only the slot that was
// touched. Writing all eight would turn every inherited slot into a frozen
// copy of whatever the global file happened to say that day.
func TestSavingANewSlotOnlyAddsThatSlot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", ".claude", FileName)
	if err := SaveSlot(path, Entry{Key: "7", Title: "ship it", Short: "ship", Prompt: "run just verify"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	f, err := ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	for _, k := range SlotKeys {
		_, ok := f.Entry(k)
		if k == "7" && !ok {
			t.Fatal("the slot that was saved is missing")
		}
		if k != "7" && ok {
			t.Fatalf("slot %s was written into a fresh project file; absence is what means inherit", k)
		}
	}
	if got := slotOf(t, Merge(parse(t, shipped), f), "7"); got.Live().Prompt != "run just verify" || !got.InProject {
		t.Fatalf("the new project slot does not override, got %+v", got)
	}
}

// TestACorruptFileIsNeverOverwritten is the refusal the footer reports. The
// band tolerates a broken config by falling back to its defaults; an editor
// that "fixed" it by rewriting it would throw away whatever the user was
// halfway through typing.
func TestACorruptFileIsNeverOverwritten(t *testing.T) {
	for _, bad := range []string{
		`{"hotkeys": [{"key": "2"`, // truncated
		`["not", "an", "object"]`,  // not an object
		`{"hotkeys": "2,3,5"}`,     // hotkeys is not an array
		`{"hotkeys": ["2", "3"]}`,  // an array, but not of objects
	} {
		dir := t.TempDir()
		path := filepath.Join(dir, FileName)
		if err := os.WriteFile(path, []byte(bad), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Parse([]byte(bad)); err == nil {
			t.Fatalf("%q parsed; the editor would then rewrite it and lose what is there", bad)
		}
		if err := SaveSlot(path, Entry{Key: "2", Prompt: "anything"}); err == nil {
			t.Fatalf("%q: save must be refused", bad)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != bad {
			t.Fatalf("a refused save changed the file:\n%s", b)
		}
		if names, _ := filepath.Glob(filepath.Join(dir, ".*")); len(names) != 0 {
			t.Fatalf("a refused save left a temp file behind: %v", names)
		}
	}
}

// TestAMissingFileIsAnEmptyConfig: the PROJECT override normally does not
// exist, and that is not an error -- it is the default state of every project
// that has never claimed a hotkey.
func TestAMissingFileIsAnEmptyConfig(t *testing.T) {
	f, err := ReadFile(filepath.Join(t.TempDir(), "nothing-here.json"))
	if err != nil {
		t.Fatalf("a missing file must not be an error: %v", err)
	}
	if _, ok := f.Entry("2"); ok {
		t.Fatal("a missing file named a slot")
	}
}

// TestPromptTextSurvivesARoundTrip guards the JSON escaping: the default
// encoder turns < > and & into \u003c, which is legal but is not what the
// user typed, in a file they are expected to open in an editor.
func TestPromptTextSurvivesARoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	prompt := `compare <old> & <new>, then say "done"`
	if err := SaveSlot(path, Entry{Key: "8", Title: "diff", Short: "diff", Prompt: prompt}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "\\u003c") {
		t.Fatalf("the prompt was HTML-escaped on the way out:\n%s", b)
	}
	f, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if e, _ := f.Entry("8"); e.Prompt != prompt {
		t.Fatalf("prompt round-tripped as %q", e.Prompt)
	}
}

// TestReadmeHelpPicksTheRuleWorthShowing: the mode shows one line of the
// file's own readme, and the line worth the row is the one stating the
// empty-prompt rule -- the only part of the format the list itself does not
// already show.
func TestReadmeHelpPicksTheRuleWorthShowing(t *testing.T) {
	f := parse(t, shipped)
	if got := ReadmeHelp(f.Readme()); !strings.Contains(got, "empty prompt") {
		t.Fatalf("readme help is %q, want the empty-prompt rule", got)
	}
	if got := ReadmeHelp([]string{"just this"}); got != "just this" {
		t.Fatalf("with no such line it should fall back to the first, got %q", got)
	}
	if got := ReadmeHelp(nil); got != "" {
		t.Fatalf("no readme should yield no help line, got %q", got)
	}
}
