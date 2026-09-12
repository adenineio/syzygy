// Package fmtx holds the formatting vocabulary the pane shares with the
// browser pane (bridge/public/app.js): compact, money, ago, clock, and the
// truncation rules.
package fmtx

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// Compact mirrors the browser's compact(): 745258 -> "745k", 1000000 -> "1.00M".
func Compact(n int64) string {
	switch {
	case n < 0:
		return "0"
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 1_000_000:
		return fmt.Sprintf("%dk", n/1000)
	default:
		return fmt.Sprintf("%.2fM", float64(n)/1_000_000)
	}
}

// Money mirrors the browser's money(): "$12.40"; three decimals under $1; no
// decimals at or above $100.
func Money(v float64) string {
	switch {
	case v < 0:
		return "$0.00"
	case v < 1:
		return fmt.Sprintf("$%.3f", v)
	case v >= 100:
		return fmt.Sprintf("$%.0f", v)
	default:
		return fmt.Sprintf("$%.2f", v)
	}
}

// Ago is the short elapsed form: 45s, 3m, 2h, 4d.
func Ago(d time.Duration) string {
	s := int64(d.Seconds())
	if s < 0 {
		s = 0
	}
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		return fmt.Sprintf("%dh", s/3600)
	default:
		return fmt.Sprintf("%dd", s/86400)
	}
}

// AgoFine is the long elapsed form used for UPTIME: 45s, 3m12s is dropped to
// 3m, 2h14m, 4d3h.
func AgoFine(d time.Duration) string {
	s := int64(d.Seconds())
	if s < 0 {
		s = 0
	}
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		if m := (s % 3600) / 60; m > 0 {
			return fmt.Sprintf("%dh%dm", s/3600, m)
		}
		return fmt.Sprintf("%dh", s/3600)
	default:
		if h := (s % 86400) / 3600; h > 0 {
			return fmt.Sprintf("%dd%dh", s/86400, h)
		}
		return fmt.Sprintf("%dd", s/86400)
	}
}

// Clock is the browser's clockOf(): 24-hour HH:MM:SS.
func Clock(t time.Time) string { return t.Format("15:04:05") }

// ClockShort is HH:MM, for M and S widths.
func ClockShort(t time.Time) string { return t.Format("15:04") }

// W measures display width the way lipgloss does.
func W(s string) int { return ansi.StringWidth(s) }

// TruncRight shortens a sentence from the right with a single ellipsis.
func TruncRight(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if W(s) <= w {
		return s
	}
	if w == 1 {
		return "…"
	}
	var b strings.Builder
	used := 0
	for _, r := range s {
		rw := W(string(r))
		if used+rw > w-1 {
			break
		}
		b.WriteRune(r)
		used += rw
	}
	return b.String() + "…"
}

// TruncLeft shortens a path from the left with a single ellipsis, which is how
// paths stay readable: …/bridge/public/app.js.
func TruncLeft(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if W(s) <= w {
		return s
	}
	if w == 1 {
		return "…"
	}
	rs := []rune(s)
	keep := make([]rune, 0, len(rs))
	used := 0
	for i := len(rs) - 1; i >= 0; i-- {
		rw := W(string(rs[i]))
		if used+rw > w-1 {
			break
		}
		keep = append(keep, rs[i])
		used += rw
	}
	// reverse
	for i, j := 0, len(keep)-1; i < j; i, j = i+1, j-1 {
		keep[i], keep[j] = keep[j], keep[i]
	}
	return "…" + string(keep)
}

// Wrap breaks a sentence into at most max lines of width w, ellipsising the
// last line rather than orphaning words. It never emits a bare cut.
func Wrap(s string, w, max int) []string {
	if w <= 0 || max <= 0 {
		return nil
	}
	words := strings.Fields(s)
	if len(words) == 0 {
		return nil
	}
	var lines []string
	cur := ""
	for i := 0; i < len(words); i++ {
		cand := words[i]
		if cur != "" {
			cand = cur + " " + words[i]
		}
		if W(cand) <= w {
			cur = cand
			continue
		}
		if cur == "" {
			// single word longer than the line
			lines = append(lines, TruncRight(words[i], w))
			cur = ""
		} else {
			lines = append(lines, cur)
			cur = words[i]
		}
		if len(lines) == max {
			// no room left; fold the rest into the last line with an ellipsis
			rest := strings.Join(words[i:], " ")
			lines[max-1] = TruncRight(lines[max-1]+" "+rest, w)
			if W(lines[max-1]) < w && !strings.HasSuffix(lines[max-1], "…") {
				lines[max-1] = TruncRight(lines[max-1]+"…", w)
			}
			return lines
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	if len(lines) > max {
		lines = lines[:max]
		lines[max-1] = TruncRight(lines[max-1]+"…", w)
	}
	return lines
}

// Pct renders a 0..1 fraction as an integer percentage with a % sign.
func Pct(f float64) string {
	if f < 0 {
		f = 0
	}
	if f > 1 {
		f = 1
	}
	return fmt.Sprintf("%d%%", int(f*100+0.5))
}

// Ms renders a duration in milliseconds the way the feed does: 89ms, 1.2s.
func Ms(ms int64) string {
	if ms <= 0 {
		return ""
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}
