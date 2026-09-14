// Command syzygy-pane is the Syzygy terminal side pane, built on the
// Charm v2 stack. It sits beside Claude Code inside a tmux window and shows
// what the browser pane shows, in a quarter of the window.
//
// This build ships VITALS only; the other three modes switch and say so.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/charmbracelet/colorprofile"

	tea "charm.land/bubbletea/v2"

	"github.com/adenineio/syzygy/pane-v2/internal/ident"
	"github.com/adenineio/syzygy/pane-v2/internal/relay"
	"github.com/adenineio/syzygy/pane-v2/internal/ui"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		relayURL   = flag.String("relay", "", "relay base URL (default http://127.0.0.1:<port from relay.json>)")
		sessionID  = flag.String("session", "", "pin this session id or unique prefix; skips identification")
		targetPane = flag.String("target-pane", "", "the tmux pane whose Claude this is (%N)")
		modeFlag   = flag.String("mode", "", "starting mode: vitals|feed|paste|board|grid|mine|hotkeys|chain")
		snapshot   = flag.Bool("snapshot", false, "print one frame at --width/--height and exit")
		width      = flag.Int("width", 60, "frame width, only with --snapshot")
		height     = flag.Int("height", 40, "frame height, only with --snapshot")
		colorFlag  = flag.String("color-profile", "", "auto|truecolor|ansi256|ansi|ascii (default auto; env SZG_COLOR)")
		debug      = flag.Bool("debug", false, "log to syzygy-pane.log")
	)
	flag.Parse()

	tok := relay.LoadToken(relay.DefaultTokenPath())

	base := *relayURL
	if base == "" {
		base = os.Getenv("SZG_RELAY")
	}
	if base == "" {
		base = fmt.Sprintf("http://127.0.0.1:%d", tok.Port())
	}

	var logger *log.Logger
	if *debug {
		f, err := os.OpenFile("syzygy-pane.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err == nil {
			defer f.Close()
			logger = log.New(f, "syzygy-pane ", log.LstdFlags|log.Lmicroseconds)
		}
	}

	cwd, _ := os.Getwd()
	targetPid := 0
	if v := os.Getenv("SZG_TARGET_PID"); v != "" {
		targetPid, _ = strconv.Atoi(strings.TrimSpace(v))
	}
	resolver := ident.New(ident.Config{
		SessionFlag: firstNonEmpty(*sessionID, os.Getenv("SZG_SESSION")),
		TargetPane:  firstNonEmpty(*targetPane, os.Getenv("SZG_TARGET_PANE")),
		TargetPid:   targetPid,
		SelfPane:    os.Getenv("TMUX_PANE"),
		Cwd:         cwd,
	})

	client := relay.NewClient(base, tok, logger)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Run(ctx)

	// The colour profile is a program option, not a global renderer. The
	// default is auto-detection plus the RGB/Tc capability request the model
	// makes in Init; this flag is the escape hatch for a terminal that answers
	// neither.
	profile, forced := parseProfile(firstNonEmpty(*colorFlag, os.Getenv("SZG_COLOR")))

	cfg := ui.Config{
		RelayURL:    base,
		Cwd:         cwd,
		StartMode:   ui.ParseMode(firstNonEmpty(*modeFlag, envOr("SZG_MODE", "vitals"))),
		ReadOnly:    !tok.Present(),
		ColorForced: forced,
		Debug:       *debug,
		Logger:      logger,
	}

	if *snapshot {
		os.Exit(runSnapshot(ctx, client, resolver, cfg, *width, *height))
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM)
	go func() {
		<-sigs
		cancel()
	}()

	opts := []tea.ProgramOption{tea.WithContext(ctx)}
	if forced {
		opts = append(opts, tea.WithColorProfile(profile))
	}
	p := tea.NewProgram(ui.New(client, resolver, cfg), opts...)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "syzygy-pane:", err)
		os.Exit(1)
	}
}

// runSnapshot connects, waits for the first snapshot (or gives up and prints
// the WAITING frame), renders one frame and exits. It is how a state is
// eyeballed outside tmux.
func runSnapshot(ctx context.Context, client *relay.Client, resolver ident.Resolver, cfg ui.Config, w, h int) int {
	m := ui.New(client, resolver, cfg)
	tm, _ := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	m = tm.(ui.Model)

	deadline := time.After(3 * time.Second)
	gotSnapshot := false
	for !gotSnapshot {
		select {
		case msg, ok := <-client.Msgs():
			if !ok {
				gotSnapshot = true
				break
			}
			tm, _ := m.Update(msg)
			m = tm.(ui.Model)
			if _, isSnap := msg.(relay.SnapshotMsg); isSnap {
				gotSnapshot = true
			}
		case <-deadline:
			gotSnapshot = true
		case <-ctx.Done():
			return 1
		}
	}
	// Give identification one pass with the sessions now in hand.
	tm2, _ := m.Update(identityNow(resolver, m))
	m = tm2.(ui.Model)
	if cfg.StartMode == ui.ModeHotkeys {
		// HOTKEYS loads its two config files by command, and a snapshot runs
		// no commands; without this the frame is always the "reading" state.
		tm3, _ := m.Update(ui.HotkeysNow(cfg.Cwd))
		m = tm3.(ui.Model)
	}
	fmt.Println(m.Render())
	if note := m.IdentNote(); note != "" {
		fmt.Fprintln(os.Stderr, "ident:", m.SelfHow().String(), "-", note)
	}
	return 0
}

// identityNow runs the resolver against the model's current session list and
// wraps the result as the message Update expects.
func identityNow(resolver ident.Resolver, m ui.Model) tea.Msg {
	return ui.IdentResult(resolver.Resolve(m.Sessions()))
}

// parseProfile maps the flag to a colorprofile value. An empty or "auto"
// value leaves detection alone.
func parseProfile(s string) (colorprofile.Profile, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "truecolor", "true", "rgb", "24bit":
		return colorprofile.TrueColor, true
	case "ansi256", "256":
		return colorprofile.ANSI256, true
	case "ansi", "16":
		return colorprofile.ANSI, true
	case "ascii", "none", "mono":
		return colorprofile.Ascii, true
	default:
		return colorprofile.TrueColor, false
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
