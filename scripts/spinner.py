#!/usr/bin/env python3
"""Pin or inspect the Syzygy HUD's turn-spinner in the global config file.

One of three ways to set the spinner: this script, the pane's settings gear
(POST /api/hud/settings in syzygy/bridge/relay.mjs), and the
band's own live picker (settings.spinnerPicker) all read and write the same
file, `~/.claude/syzygy-hud-hotkeys.json`, at `settings.spinner`. That file's
own precedence (hud.tsx's `resolveSpinnerId`): the file wins over `$.store`
when it names a real id; $.store (the picker's live choice) governs when the
file says nothing.

Stdlib only, on purpose -- this project's rule is Python via uv for anything
with dependencies, but a plain `python3` script is fine when it has none --
see relay-status/dispatch-status in the justfile, which already call
`python3 -c` directly for the same reason. The valid id list is never
hard-coded here: it asks
scripts/spinner-ids.mjs, which reads spinner-frames.js, so this script cannot
drift from the band it is configuring.

Usage:
    spinner.py <id>       set settings.spinner to <id> in the global config
    spinner.py --list     print every valid id and name
    spinner.py --ensure   write the shipped default config if none exists yet
                          (a no-op if the file is already there); `just
                          install` runs this so a fresh machine has a file to
                          edit at all.
"""
import json
import os
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPINNER_IDS_SCRIPT = os.path.join(REPO_ROOT, "scripts", "spinner-ids.mjs")

# Overridable for the test harness (test/spinner-script-harness.mjs), the same
# way relay.mjs's own paths are overridable by SZG_DATA_DIR -- never touches a
# developer's real config file during a test run.
GLOBAL_CONFIG = os.environ.get("SZG_HUD_CONFIG") or os.path.join(
    os.path.expanduser("~"), ".claude", "syzygy-hud-hotkeys.json"
)

# What ships when no config file exists yet -- the same shape and the same two
# filled example slots as hud.tsx's own DEFAULT_HOTKEYS, plus the settings
# block documented here. Kept here rather than in a second copy anywhere else:
# `just install` calls this script's --ensure rather than writing the file
# itself, so this is the one place the shipped default is spelled out.
SHIPPED_DEFAULT = {
    "_readme": [
        "Syzygy HUD config. Pressing a hotkey submits its prompt into the session.",
        "A band hotkey must be a single DIGIT - letters are refused by the engine.",
        "1 (open pane) and 4 (what now?) are built in; these eight slots are yours:",
        "2, 3, 5, 6, 7, 8, 9, 0 - shown in that order, 0 reading last.",
        "title = the label when the row is wide; short = the label when it is not.",
        "An entry with an empty prompt is hidden, so the stubs below are templates.",
        "settings.spinnerPicker: show the spinner dropdown row in the band (off).",
        "settings.pieStyle: 'moon' (big, emoji-width) or 'circle' (small, 1 column);",
        "  both run FULL at 0% used and EMPTY at 100% - a gauge of what is left.",
        "settings.spinner: pin a spinner id ('just spinners' lists id and name).",
        "  Wins over the band picker/$.store when set to a real id; leave it unset",
        "  (or use the pane's gear, or 'just spinner <id>') to let the live picker's",
        "  own choice govern instead.",
        "A project may override any slot or setting in",
        "<repo>/.claude/syzygy-hud-hotkeys.json; what it does not name is inherited.",
        "Re-read at every turn boundary - no restart needed.",
    ],
    "settings": {"spinnerPicker": False, "pieStyle": "moon"},
    "hotkeys": [
        {
            "key": "2",
            "title": "my next steps",
            "short": "next",
            "prompt": (
                "What are MY next action steps here to move forward (things "
                "needing my review, or testing, configuring, or any other "
                "manual action I must take to have this session keep moving "
                "forward)"
            ),
        },
        {
            "key": "3",
            "title": "step back",
            "short": "back",
            "prompt": (
                "Step back for a moment: am I solving the right problem "
                "here, and is there a simpler route to the actual goal? "
                "Answer in three sentences before continuing."
            ),
        },
        {"key": "5", "title": "", "short": "", "prompt": ""},
        {"key": "6", "title": "", "short": "", "prompt": ""},
        {"key": "7", "title": "", "short": "", "prompt": ""},
        {"key": "8", "title": "", "short": "", "prompt": ""},
        {"key": "9", "title": "", "short": "", "prompt": ""},
        {"key": "0", "title": "", "short": "", "prompt": ""},
    ],
}


def valid_spinners():
    """The real {id: name} map, from spinner-frames.js via node -- never a
    second, hand-maintained copy of the list."""
    out = subprocess.run(
        ["node", SPINNER_IDS_SCRIPT],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    )
    return {s["id"]: s["name"] for s in json.loads(out.stdout)}


def atomic_write(path, data):
    """Same contract as claims.mjs/requests.mjs: serialize, write to a temp
    file in the same directory, then rename over the target. A failed
    serialize or write leaves the previous file intact."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".syzygy-hud-hotkeys-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_default():
    """Write the shipped default if, and only if, nothing is there yet.
    Never overwrites an existing file -- this is a bootstrap, not a reset."""
    if os.path.exists(GLOBAL_CONFIG):
        return False
    atomic_write(GLOBAL_CONFIG, SHIPPED_DEFAULT)
    return True


def load():
    if not os.path.exists(GLOBAL_CONFIG):
        ensure_default()
    with open(GLOBAL_CONFIG) as f:
        return json.load(f)


def set_spinner(spinner_id):
    names = valid_spinners()
    if spinner_id not in names:
        sys.stderr.write(f"unknown spinner id: {spinner_id!r}\n")
        sys.stderr.write("valid ids: " + ", ".join(sorted(names)) + "\n")
        sys.stderr.write("(see `just spinners` for id and name together)\n")
        return 1

    data = load()
    if not isinstance(data, dict):
        sys.stderr.write(f"{GLOBAL_CONFIG} does not hold a JSON object; refusing to touch it\n")
        return 1
    # Preserves every other field -- _readme, hotkeys, and any other setting --
    # untouched, the same "hand-editable, never clobbered" contract claims.mjs
    # and requests.mjs document for their own files.
    settings = data.get("settings")
    settings = dict(settings) if isinstance(settings, dict) else {}
    settings["spinner"] = spinner_id
    data = {**data, "settings": settings}
    atomic_write(GLOBAL_CONFIG, data)
    print(f"spinner -> {spinner_id} ({names[spinner_id]}) written to {GLOBAL_CONFIG}")
    print("takes effect at the next turn boundary in any running session; no restart needed.")
    return 0


def main(argv):
    if not argv:
        sys.stderr.write(__doc__ + "\n")
        return 1
    if argv[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ + "\n")
        return 0
    if argv[0] == "--list":
        names = valid_spinners()
        width = max(len(i) for i in names) + 2
        for spinner_id, name in names.items():
            print(f"{spinner_id.ljust(width)}{name}")
        return 0
    if argv[0] == "--ensure":
        created = ensure_default()
        print(f"wrote the shipped default to {GLOBAL_CONFIG}" if created else "already exists, left alone")
        return 0
    if argv[0].startswith("-"):
        sys.stderr.write(f"unknown option: {argv[0]}\n")
        return 1
    return set_spinner(argv[0])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
