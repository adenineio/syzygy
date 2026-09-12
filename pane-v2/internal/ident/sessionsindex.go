package ident

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// Entry is one record of Claude Code's own pid index at
// ~/.claude/sessions/<pid>.json. It is Claude Code internal and undocumented,
// so it is never the primary mechanism -- but reading it for each descendant
// pid gives the session id *before the plugin has registered*, which turns
// "no sessions yet" into "waiting for <name> (<id>) to join the board".
type Entry struct {
	Pid       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Name      string `json:"name"`
	Status    string `json:"status"`
}

// Index reads Claude Code's pid index.
type Index interface {
	// Lookup returns the record for one pid, if the file exists and parses.
	Lookup(pid int) (Entry, bool)
}

// DirIndex reads a directory of <pid>.json files.
type DirIndex struct{ Dir string }

// DefaultIndex points at ~/.claude/sessions.
func DefaultIndex() DirIndex {
	home, err := os.UserHomeDir()
	if err != nil {
		return DirIndex{}
	}
	return DirIndex{Dir: filepath.Join(home, ".claude", "sessions")}
}

// Lookup implements Index. Any read or parse error is ignored: this is a hint,
// never a source of truth.
func (d DirIndex) Lookup(pid int) (Entry, bool) {
	if d.Dir == "" || pid <= 0 {
		return Entry{}, false
	}
	b, err := os.ReadFile(filepath.Join(d.Dir, strconv.Itoa(pid)+".json"))
	if err != nil {
		return Entry{}, false
	}
	var e Entry
	if json.Unmarshal(b, &e) != nil || e.SessionID == "" {
		return Entry{}, false
	}
	if e.Pid == 0 {
		e.Pid = pid
	}
	return e, true
}
