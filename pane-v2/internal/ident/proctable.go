package ident

import (
	"bufio"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ProcTable yields a pid -> ppid map of every process on the machine.
type ProcTable interface {
	Table() (map[int]int, error)
}

// PSTable shells out to `ps -axo pid=,ppid=` -- one exec, accepted by both
// darwin and linux -- and caches the result briefly so a burst of `sessions`
// frames does not fork ps once per frame.
type PSTable struct {
	mu     sync.Mutex
	cached map[int]int
	at     time.Time
	ttl    time.Duration
}

// NewPSTable builds a table with a 5s cache.
func NewPSTable() *PSTable { return &PSTable{ttl: 5 * time.Second} }

// Table implements ProcTable.
func (p *PSTable) Table() (map[int]int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cached != nil && time.Since(p.at) < p.ttl {
		return p.cached, nil
	}
	out, err := exec.Command("ps", "-axo", "pid=,ppid=").Output()
	if err != nil {
		return p.cached, err
	}
	t := ParsePS(string(out))
	p.cached, p.at = t, time.Now()
	return t, nil
}

// ParsePS turns `ps -axo pid=,ppid=` output into a pid -> ppid map. Exported
// so the resolver test can feed it a recorded table.
func ParsePS(s string) map[int]int {
	t := make(map[int]int, 512)
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		t[pid] = ppid
	}
	return t
}

// Descendants walks the process table breadth-first from each root and returns
// every descendant pid, the roots included, to a depth of maxDepth.
func Descendants(table map[int]int, roots []int, maxDepth int) map[int]bool {
	seen := make(map[int]bool, len(roots)*4)
	if len(table) == 0 || len(roots) == 0 {
		return seen
	}
	// children index
	kids := make(map[int][]int, len(table))
	for pid, ppid := range table {
		kids[ppid] = append(kids[ppid], pid)
	}
	frontier := make([]int, 0, len(roots))
	for _, r := range roots {
		if r > 0 && !seen[r] {
			seen[r] = true
			frontier = append(frontier, r)
		}
	}
	for depth := 0; depth < maxDepth && len(frontier) > 0; depth++ {
		var next []int
		for _, p := range frontier {
			for _, k := range kids[p] {
				if !seen[k] {
					seen[k] = true
					next = append(next, k)
				}
			}
		}
		frontier = next
	}
	return seen
}
