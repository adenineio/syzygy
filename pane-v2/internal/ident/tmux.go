package ident

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Pane is a tmux pane id and the pid of its first process (its shell).
type Pane struct {
	ID  string
	Pid int
}

// Tmux is the slice of tmux the resolver needs.
type Tmux interface {
	// Inside reports whether the pane is running under tmux at all.
	Inside() bool
	// PanePid returns #{pane_pid} for one pane id.
	PanePid(paneID string) (int, error)
	// SiblingPanes lists every pane of the window containing self, excluding
	// self. With -t a pane, list-panes lists that pane's window.
	SiblingPanes(self string) ([]Pane, error)
}

// RealTmux shells out to the tmux binary.
type RealTmux struct{}

// Inside implements Tmux.
func (RealTmux) Inside() bool { return os.Getenv("TMUX") != "" }

// PanePid implements Tmux.
func (RealTmux) PanePid(paneID string) (int, error) {
	args := []string{"display-message", "-p"}
	if paneID != "" {
		args = append(args, "-t", paneID)
	}
	args = append(args, "#{pane_pid}")
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}

// SiblingPanes implements Tmux.
func (RealTmux) SiblingPanes(self string) ([]Pane, error) {
	args := []string{"list-panes"}
	if self != "" {
		args = append(args, "-t", self)
	}
	args = append(args, "-F", "#{pane_id} #{pane_pid}")
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		return nil, err
	}
	var panes []Pane
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		pid, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		if self != "" && f[0] == self {
			continue
		}
		panes = append(panes, Pane{ID: f[0], Pid: pid})
	}
	return panes, nil
}
