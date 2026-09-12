package fmtx

import (
	"strings"
	"testing"
	"time"
)

func TestCompactMatchesTheBrowser(t *testing.T) {
	cases := map[int64]string{
		0: "0", 999: "999", 1000: "1k", 745258: "745k", 1_000_000: "1.00M", 12_345_678: "12.35M",
	}
	for in, want := range cases {
		if got := Compact(in); got != want {
			t.Errorf("Compact(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestMoneyMatchesTheBrowser(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{78.6886, "$78.69"}, {0.5, "$0.500"}, {120, "$120"}, {0, "$0.000"}, {99.994, "$99.99"},
	}
	for _, c := range cases {
		if got := Money(c.in); got != c.want {
			t.Errorf("Money(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAgoBoundaries(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{0, "0s"}, {59 * time.Second, "59s"}, {time.Minute, "1m"},
		{59 * time.Minute, "59m"}, {time.Hour, "1h"}, {25 * time.Hour, "1d"},
	}
	for _, c := range cases {
		if got := Ago(c.d); got != c.want {
			t.Errorf("Ago(%v) = %q, want %q", c.d, got, c.want)
		}
	}
	if got := AgoFine(2*time.Hour + 14*time.Minute); got != "2h14m" {
		t.Errorf("AgoFine = %q, want 2h14m", got)
	}
}

func TestTruncationUsesExactlyOneEllipsis(t *testing.T) {
	long := "/home/dev/demo/bridge/public/app.js"
	r := TruncRight(long, 20)
	if W(r) != 20 || strings.Count(r, "…") != 1 || !strings.HasSuffix(r, "…") {
		t.Errorf("TruncRight = %q (width %d)", r, W(r))
	}
	l := TruncLeft(long, 20)
	if W(l) != 20 || strings.Count(l, "…") != 1 || !strings.HasPrefix(l, "…") {
		t.Errorf("TruncLeft = %q (width %d)", l, W(l))
	}
	if got := TruncRight("short", 20); got != "short" {
		t.Errorf("a short string must not be touched, got %q", got)
	}
	if got := TruncRight("abc", 1); got != "…" {
		t.Errorf("width 1 = %q, want the ellipsis alone", got)
	}
	if got := TruncRight("abc", 0); got != "" {
		t.Errorf("width 0 = %q, want empty", got)
	}
}

func TestWrapNeverOrphansAnEllipsis(t *testing.T) {
	s := "Agent is waiting/pausing for 205 seconds before proceeding with the next step of the plan."
	lines := Wrap(s, 30, 2)
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d: %q", len(lines), lines)
	}
	for i, ln := range lines {
		if W(ln) > 30 {
			t.Errorf("line %d is %d cells wide: %q", i, W(ln), ln)
		}
	}
	if !strings.HasSuffix(lines[1], "…") {
		t.Errorf("a truncated wrap must end in an ellipsis, got %q", lines[1])
	}
	if got := Wrap("", 30, 2); got != nil {
		t.Errorf("empty text wraps to nothing, got %q", got)
	}
}

func TestMsFormatting(t *testing.T) {
	if got := Ms(89); got != "89ms" {
		t.Errorf("Ms(89) = %q", got)
	}
	if got := Ms(1234); got != "1.2s" {
		t.Errorf("Ms(1234) = %q", got)
	}
	if got := Ms(0); got != "" {
		t.Errorf("Ms(0) = %q, want empty", got)
	}
}
