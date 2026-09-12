// Package hotkeys reads and writes the band's prompt-slot config file:
// ~/.claude/syzygy-hud-hotkeys.json, and the per-worktree override at
// <worktree root>/.claude/syzygy-hud-hotkeys.json that is written over it
// slot by slot.
//
// The format is hand-edited, so everything here is written to be conservative
// with what it did not author:
//
//   - Object key ORDER survives a rewrite. The file opens with a `_readme`
//     that explains itself; a save that shuffled it to the bottom (which is
//     what a plain map[string]any round-trip does, since Go marshals map keys
//     sorted) would make every save look like vandalism in a diff.
//   - Every key and every field this package does not know about is carried
//     through verbatim -- `settings`, `_readme`, the `spinner` key another
//     agent is adding, anything a later version invents.
//   - A file that will not parse is never overwritten. The band tolerates a
//     broken file by falling back to its defaults; an editor that "fixed" it
//     by rewriting it would throw the user's work away instead.
package hotkeys

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// FileName is the config file's name, in ~/.claude and in <worktree>/.claude
// alike.
const FileName = "syzygy-hud-hotkeys.json"

// SlotKeys are the eight digits the band leaves to the user, in the order the
// band shows them. `1` (open pane) and `4` (what now?) are built in, and a
// band hotkey must be a single digit -- ButtonProps.hotkey refuses letters --
// so there are exactly these eight, forever. `0` reads last on a keyboard
// even though it sorts first, which is why the order is listed rather than
// derived.
var SlotKeys = []string{"2", "3", "5", "6", "7", "8", "9", "0"}

// IsSlot reports whether a digit is one of the eight.
func IsSlot(key string) bool {
	for _, k := range SlotKeys {
		if k == key {
			return true
		}
	}
	return false
}

// Entry is one slot as the file stores it.
type Entry struct {
	Key    string
	Title  string
	Short  string
	Prompt string
}

// ---------------------------------------------------------------- ordered

// obj is a JSON object that remembers the order its keys were written in, so
// a rewrite produces the same file with the edited values changed and nothing
// else moved.
type obj struct {
	keys []string
	vals map[string]json.RawMessage
}

func (o *obj) UnmarshalJSON(b []byte) error {
	o.keys, o.vals = nil, map[string]json.RawMessage{}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	t, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return errors.New("want a JSON object")
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return err
		}
		k, ok := kt.(string)
		if !ok {
			return errors.New("want an object key")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		if _, seen := o.vals[k]; !seen {
			o.keys = append(o.keys, k)
		}
		o.vals[k] = raw
	}
	_, err = dec.Token() // the closing brace
	return err
}

// MarshalJSON writes the object compactly in its remembered order. The
// encoder that calls it re-indents the whole document afterwards, so this
// does not try to pretty-print anything itself.
func (o obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := marshalString(k)
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		v := o.vals[k]
		if len(v) == 0 {
			v = json.RawMessage("null")
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (o *obj) get(k string) (json.RawMessage, bool) {
	if o.vals == nil {
		return nil, false
	}
	v, ok := o.vals[k]
	return v, ok
}

func (o *obj) set(k string, v json.RawMessage) {
	if o.vals == nil {
		o.vals = map[string]json.RawMessage{}
	}
	if _, seen := o.vals[k]; !seen {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

// str reads a string field, or "" when it is absent or is not a string. A
// wrong-typed value is ignored rather than rejected, the way the band's own
// parser ignores it: one bad field must not cost the user the file.
func (o *obj) str(k string) string {
	raw, ok := o.get(k)
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// marshalRaw encodes a value as compact JSON with HTML escaping OFF.
//
// Escaping has to be off at EVERY level, not just the outermost one. The
// default turns < > and & into their \u00xx forms, and json.Marshal applies
// it to the bytes of a json.RawMessage too -- so a prompt marshalled with the
// default here would still be escaped after the outer encoder that has
// escaping off has run. Legal JSON either way, but not what the user typed,
// and this file is meant to stay readable by hand.
func marshalRaw(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// marshalString is marshalRaw for a string.
func marshalString(s string) ([]byte, error) { return marshalRaw(s) }

// ------------------------------------------------------------------- file

// File is one config file: every key it holds, in order, plus its `hotkeys`
// array decoded far enough to edit one slot without disturbing the rest.
type File struct {
	root  obj
	slots []obj
}

// Parse decodes a config file. An empty file is an empty config, not a broken
// one; anything that is not a JSON object, or whose `hotkeys` is not an array
// of objects, is an error and the caller must refuse to write over it.
//
// This is stricter than the band's own reader on purpose. hud.tsx DROPS a
// malformed entry and carries on, because all it has to do is render. An
// editor that dropped one would delete it on the next save.
func Parse(b []byte) (*File, error) {
	f := &File{}
	if len(bytes.TrimSpace(b)) == 0 {
		return f, nil
	}
	if err := json.Unmarshal(b, &f.root); err != nil {
		return nil, fmt.Errorf("not a JSON object: %w", err)
	}
	raw, ok := f.root.get("hotkeys")
	if !ok {
		return f, nil
	}
	if err := json.Unmarshal(raw, &f.slots); err != nil {
		return nil, fmt.Errorf("`hotkeys` is not an array of objects: %w", err)
	}
	return f, nil
}

// Entry returns one slot as the file states it.
func (f *File) Entry(key string) (Entry, bool) {
	if f == nil {
		return Entry{}, false
	}
	for i := range f.slots {
		if f.slots[i].str("key") == key {
			return Entry{
				Key:    key,
				Title:  f.slots[i].str("title"),
				Short:  f.slots[i].str("short"),
				Prompt: f.slots[i].str("prompt"),
			}, true
		}
	}
	return Entry{}, false
}

// SetEntry writes a slot's three editable fields, leaving every other field
// on that entry -- and the entry's position in the array -- alone. A slot the
// file does not name yet is appended, which is what makes a PROJECT file
// created on a first save hold only the slots that were actually touched:
// absence already means "inherit".
func (f *File) SetEntry(e Entry) error {
	title, err := marshalString(e.Title)
	if err != nil {
		return err
	}
	short, err := marshalString(e.Short)
	if err != nil {
		return err
	}
	prompt, err := marshalString(e.Prompt)
	if err != nil {
		return err
	}
	for i := range f.slots {
		if f.slots[i].str("key") == e.Key {
			f.slots[i].set("title", title)
			f.slots[i].set("short", short)
			f.slots[i].set("prompt", prompt)
			return nil
		}
	}
	key, err := marshalString(e.Key)
	if err != nil {
		return err
	}
	var o obj
	o.set("key", key)
	o.set("title", title)
	o.set("short", short)
	o.set("prompt", prompt)
	f.slots = append(f.slots, o)
	return nil
}

// Readme is the file's `_readme`, as lines. It accepts the array the shipped
// file uses and a plain string, and returns nothing for anything else.
func (f *File) Readme() []string {
	if f == nil {
		return nil
	}
	raw, ok := f.root.get("_readme")
	if !ok {
		return nil
	}
	var lines []string
	if err := json.Unmarshal(raw, &lines); err == nil {
		return lines
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil && one != "" {
		return []string{one}
	}
	return nil
}

// ReadmeHelp picks the one line of a `_readme` worth showing in the mode: the
// one that states the empty-prompt rule, which is the only part of the format
// that is not obvious from the list itself. It falls back to the first line,
// so a file with a readme of its own still explains itself.
func ReadmeHelp(lines []string) string {
	for _, ln := range lines {
		if strings.Contains(strings.ToLower(ln), "empty prompt") {
			return strings.TrimSpace(ln)
		}
	}
	for _, ln := range lines {
		if s := strings.TrimSpace(ln); s != "" {
			return s
		}
	}
	return ""
}

// Bytes renders the file back to JSON: every key in its original order, two
// space indent, HTML escaping off, one trailing newline -- the shape the
// shipped file already has.
func (f *File) Bytes() ([]byte, error) {
	root := obj{keys: append([]string(nil), f.root.keys...), vals: map[string]json.RawMessage{}}
	for k, v := range f.root.vals {
		root.vals[k] = v
	}
	slots := f.slots
	if slots == nil {
		slots = []obj{} // an empty array, never a bare `null`
	}
	arr, err := marshalRaw(slots)
	if err != nil {
		return nil, err
	}
	root.set("hotkeys", arr)

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ------------------------------------------------------------------ merge

// Scope is which of the two files the mode is pointed at.
type Scope int

const (
	// Global is ~/.claude/syzygy-hud-hotkeys.json.
	Global Scope = iota
	// Project is <worktree root>/.claude/syzygy-hud-hotkeys.json.
	Project
)

// String names the scope for the header.
func (s Scope) String() string {
	if s == Project {
		return "PROJECT"
	}
	return "GLOBAL"
}

// Other is the scope the toggle key switches to.
func (s Scope) Other() Scope {
	if s == Project {
		return Global
	}
	return Project
}

// Slot is one digit as the two files leave it: each file's own entry, and
// which of them named it at all.
//
// The two halves are kept apart rather than collapsed to one value because
// the mode edits one file at a time. A GLOBAL row must show what the global
// file says even when a project has overridden it -- otherwise the row lies
// about the thing the next keystroke writes -- while a PROJECT row shows what
// is actually in force here. `In` is the one place that choice is made.
type Slot struct {
	Key string

	Global  Entry
	Project Entry
	// InGlobal / InProject say which files name this slot at all, which is
	// not the same question as whether their entry has a prompt: "named, with
	// an empty prompt" is a real and meaningful state -- it is how a project
	// turns a global slot OFF, in a format where absence already means
	// "inherit".
	InGlobal  bool
	InProject bool
}

// Live is what the band would show here: the project's entry over the global
// one, whole, the way mergeHotkeys does it slot by slot.
func (s Slot) Live() Entry {
	if s.InProject {
		return s.Project
	}
	return s.Global
}

// In is the entry the given scope is responsible for -- what a row in that
// scope shows and what its editor opens on.
func (s Slot) In(scope Scope) Entry {
	if scope == Project {
		return s.Live()
	}
	return s.Global
}

// Hidden reports whether the band would skip this slot. It mirrors hud.tsx's
// mergeHotkeys exactly: a slot renders only when it has both a prompt and a
// title, and since parsing back-fills title from short and short from title,
// an empty title means both were empty.
func (s Slot) Hidden() bool { return hidden(s.Live()) }

// HiddenIn asks the same question of one scope's own entry.
func (s Slot) HiddenIn(scope Scope) bool { return hidden(s.In(scope)) }

func hidden(e Entry) bool { return e.Prompt == "" || e.Title == "" }

// normalise mirrors hud.tsx's parseHotkeys: trim, then back-fill title from
// short and short from title, so one of the two is enough to label a slot.
func normalise(e Entry) Entry {
	e.Title, e.Short = strings.TrimSpace(e.Title), strings.TrimSpace(e.Short)
	e.Prompt = strings.TrimSpace(e.Prompt)
	if e.Title == "" {
		e.Title = e.Short
	}
	if e.Short == "" {
		e.Short = e.Title
	}
	return e
}

// Merge is the whole point of the mode: the two files' slots, in the band's
// display order, each remembering where it came from. What Live() yields is
// what the band would show, which is the only view of this file worth editing
// against.
func Merge(global, project *File) []Slot {
	out := make([]Slot, 0, len(SlotKeys))
	for _, key := range SlotKeys {
		s := Slot{Key: key, Global: Entry{Key: key}, Project: Entry{Key: key}}
		if e, ok := global.Entry(key); ok {
			s.InGlobal, s.Global = true, normalise(e)
		}
		if e, ok := project.Entry(key); ok {
			s.InProject, s.Project = true, normalise(e)
		}
		out = append(out, s)
	}
	return out
}

// Badge is the one word a row wears, saying where its value came from and
// whether the band will show it at all.
//
// Four words, not three: a slot no file has ever filled
// is `unset`, which is a different fact from `hidden` (something turned it OFF
// here) and reads as one. In GLOBAL scope there is nothing to inherit from, so
// only the on/off distinction is left.
func Badge(s Slot, scope Scope) string {
	if scope == Global {
		switch {
		case !s.InGlobal:
			return "unset"
		case hidden(s.Global):
			return "hidden"
		}
		return ""
	}
	switch {
	case s.InProject && hidden(s.Project):
		return "hidden"
	case s.InProject:
		return "set here"
	case s.Hidden():
		// Either the global file does not name it, or it names it with an
		// empty prompt. Both mean the band shows nothing and the project has
		// said nothing, which is one state, not two.
		return "unset"
	}
	return "inherited"
}

// -------------------------------------------------------------------- i/o

// Loaded is one pass over both files, plus where they were looked for.
type Loaded struct {
	GlobalPath  string
	ProjectPath string
	// Root is the worktree root git named, or "" when it could not be asked.
	Root string

	Global  *File
	Project *File

	GlobalErr  error
	ProjectErr error
}

// ReadFile parses a config file. A file that is not there is an empty config
// -- the PROJECT override normally does not exist until the first save --
// while one that will not parse is an error, and the caller must not write
// over it.
func ReadFile(path string) (*File, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &File{}, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// Load reads both files for a session whose working directory is cwd. It runs
// git, so it belongs off the UI goroutine.
func Load(cwd string) Loaded {
	var l Loaded
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		l.GlobalPath = filepath.Join(home, ".claude", FileName)
		l.Global, l.GlobalErr = ReadFile(l.GlobalPath)
	} else {
		l.GlobalErr = errors.New("no home directory")
	}
	l.Root = WorktreeRoot(cwd)
	if l.Root != "" {
		l.ProjectPath = filepath.Join(l.Root, ".claude", FileName)
		l.Project, l.ProjectErr = ReadFile(l.ProjectPath)
	}
	if l.Global == nil {
		l.Global = &File{}
	}
	if l.Project == nil {
		l.Project = &File{}
	}
	return l
}

// WorktreeRoot asks git where the worktree containing cwd starts. It is asked
// rather than guessed: a session may be running in any subdirectory, and a
// git worktree's root is not something a path walk can tell from a checkout's.
// Spawned by argv, never through a shell. An empty answer means "no project
// scope here", which the mode says out loud rather than inventing a path.
func WorktreeRoot(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// SaveSlot writes one slot into the file at path and leaves everything else
// exactly as it was.
//
// The file is re-read here rather than taken from the caller's copy, so an
// edit made by hand -- or by the band's own installer -- between opening the
// mode and pressing enter is respected rather than clobbered. A file that
// will not parse is refused: the caller reports it and nothing is written.
//
// The write is atomic: serialize first, then a temp file in the same
// directory, then a rename over the target. A failed serialize leaves the
// previous file intact, which is the rule every authoritative store in this
// project is held to.
func SaveSlot(path string, e Entry) error {
	if path == "" {
		return errors.New("no path for this scope")
	}
	f, err := ReadFile(path)
	if err != nil {
		return err
	}
	if err := f.SetEntry(e); err != nil {
		return err
	}
	b, err := f.Bytes()
	if err != nil {
		return err
	}
	return writeAtomic(path, b)
}

func writeAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+FileName+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name) // a no-op once the rename has taken it away
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
