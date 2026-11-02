#!/usr/bin/env bash
# Installs the herdr-voice-agent mods into Herdr and its helpers into ~/.local/share/herdr-voice-agent.
#
#   ./install.sh                     mods, helpers, Python env, one voice pack, speech-to-text model
#   ./install.sh --claude-hooks      also add the read-aloud hooks to ~/.claude/settings.json
#   ./install.sh --voice NAME        install this Piper voice pack instead of en_US-lessac-medium
#   ./install.sh --no-voice          skip the voice pack (the robotic system voice is used)
#   ./install.sh --no-mic            skip the speech-to-text model (the Talk button won't work)
#   ./install.sh --dock              build the banner into the window: a copy of the main layout,
#                                    named voice-agent, with a strip above the status bar
#   ./install.sh --uninstall         remove the mods and helpers (voice packs and models too)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
DATA="${HERDR_VOICE_HOME:-$HOME/.local/share/herdr-voice-agent}"
VOICE="en_US-lessac-medium"
HOOKS=0 MIC=1 UNINSTALL=0 DOCK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --claude-hooks) HOOKS=1 ;;
    --voice) VOICE="$2"; shift ;;
    --no-voice) VOICE="" ;;
    --no-mic) MIC=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --dock) DOCK=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

if [ "$UNINSTALL" = 1 ]; then
  if [ -f "$HERDR_HOME/layouts/voice-agent.json" ]; then
    command -v herdr-app >/dev/null && herdr-app do layout.switch --name main >/dev/null 2>&1 || true
    rm -f "$HERDR_HOME/layouts/voice-agent.json"
  fi
  rm -rf "$HERDR_HOME/mods/voice-agent" "$HERDR_HOME/mods/voice-agent-voices"
  # Only delete a folder this installer made, whatever HERDR_VOICE_HOME says.
  if [ -f "$DATA/bin/say.py" ] && [ -d "$DATA/venv" ]; then rm -rf "$DATA"; else warn "$DATA doesn't look like a herdr-voice-agent folder; left it alone."; fi
  say "Removed the mods, the voice-agent layout and $DATA. Restart Herdr to clear a floating banner that was open."
  say "If you added the Claude Code hooks, remove the speak-reply.py entries with /hooks in Claude Code."
  exit 0
fi

[ -d "$HERDR_HOME" ] || { echo "Herdr's folder $HERDR_HOME doesn't exist. Install and start Herdr first." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
command -v spd-say >/dev/null || warn "spd-say (speech-dispatcher) isn't installed: only voice packs will speak."
command -v pw-record >/dev/null || command -v parecord >/dev/null || warn "pw-record or parecord is needed for the Talk button."
python3 -c 'import gi; gi.require_version("Gtk", "3.0")' 2>/dev/null \
  || warn "Python GTK bindings (python3-gi, gir1.2-gtk-3.0) are needed for Read selection."

# Never replace someone else's mod that happens to share a name.
for mod in voice-agent voice-agent-voices; do
  if [ -f "$HERDR_HOME/mods/$mod/main.js" ] && ! grep -q 'herdr-voice-agent' "$HERDR_HOME/mods/$mod/main.js"; then
    echo "$HERDR_HOME/mods/$mod belongs to another mod; move it aside and run this again." >&2
    exit 1
  fi
done

say "Installing helpers into $DATA"
mkdir -p "$DATA/bin" "$DATA/spool" "$DATA/state" "$DATA/voices" "$DATA/models"
chmod 700 "$DATA" "$DATA/spool" "$DATA/state"  # replies and recordings are private
cp "$REPO"/bin/*.py "$DATA/bin/"
chmod +x "$DATA"/bin/*.py

say "Setting up the Python environment (Piper voices, faster-whisper speech-to-text)"
# Pinned to the versions this was tested with.
PACKAGES=(piper-tts==1.8.0)
[ "$MIC" = 1 ] && PACKAGES+=(faster-whisper==1.2.1)
if command -v uv >/dev/null; then
  [ -x "$DATA/venv/bin/python" ] || uv venv -q "$DATA/venv"
  VIRTUAL_ENV="$DATA/venv" uv pip install -q "${PACKAGES[@]}"
else
  [ -x "$DATA/venv/bin/python" ] || python3 -m venv "$DATA/venv"
  "$DATA/venv/bin/pip" install -q --upgrade pip
  "$DATA/venv/bin/pip" install -q "${PACKAGES[@]}"
fi

if [ -n "$VOICE" ] && [ ! -f "$DATA/voices/$VOICE.onnx" ]; then
  say "Downloading the voice pack $VOICE"
  "$DATA/venv/bin/python" "$DATA/bin/get-voice.py" "$VOICE"
fi

if [ "$MIC" = 1 ]; then
  say "Downloading the speech-to-text model (once)"
  "$DATA/venv/bin/python" "$DATA/bin/listen.py" warmup
fi

say "Installing the mods into $HERDR_HOME/mods"
mkdir -p "$HERDR_HOME/mods"
for mod in voice-agent voice-agent-voices; do
  rm -rf "$HERDR_HOME/mods/$mod"
  cp -r "$REPO/mods/$mod" "$HERDR_HOME/mods/$mod"
done

if [ "$HOOKS" = 1 ]; then
  say "Adding the read-aloud hooks to ~/.claude/settings.json"
  python3 - "$DATA/bin/speak-reply.py" <<'EOF'
import json, os, shutil, sys
script = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
settings = {}
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
    shutil.copy2(path, path + ".bak-herdr-voice-agent")
    print(f"backed up {path} to {path}.bak-herdr-voice-agent")
hooks = settings.setdefault("hooks", {})
def hook(flag="", wait=False):
    h = {"type": "command", "command": f"{script}{' ' + flag if flag else ''} 2>/dev/null || true"}
    return h if wait else dict(h, **{"async": True})

# (event, tool matcher, hook): the reply when a turn ends; a question or permission prompt while
# the agent waits on you (that turn hasn't ended); stop talking once you answer.
wanted = [
    ("Stop", None, hook()),
    ("PreToolUse", "AskUserQuestion", hook("--ask")),
    ("Notification", None, hook("--notify")),
    ("UserPromptSubmit", None, hook("--stop", wait=True)),
    ("PostToolUse", "AskUserQuestion", hook("--stop")),
]
for event, matcher, h in wanted:
    groups = hooks.setdefault(event, [])
    if any(x.get("command") == h["command"] for g in groups for x in g.get("hooks", [])):
        continue  # already added by an earlier install
    groups.append({"matcher": matcher, "hooks": [h]} if matcher else {"hooks": [h]})
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + ".tmp", "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(path + ".tmp", path)
EOF
  say "Hooks added. In running Claude Code sessions, open /hooks once (or restart) to load them."
fi

if command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; then
  for mod in voice-agent voice-agent-voices; do herdr-app check "$HERDR_HOME/mods/$mod" >/dev/null; done
  if [ "$DOCK" = 1 ]; then
    # Herdr's own layouts are read-only, so the strip goes into a personal copy of "main".
    [ -f "$HERDR_HOME/layouts/voice-agent.json" ] || herdr-app do layout.clone --name main --as voice-agent >/dev/null
    python3 "$DATA/bin/dock-layout.py" "$HERDR_HOME/layouts/voice-agent.json"
    herdr-app do layout.switch --name voice-agent >/dev/null
    say "Herdr now shows the voice-agent layout: your main layout with the Voice Agent strip above the status bar."
    say "Ctrl+Shift+L switches layouts; Herdr's main layout itself is unchanged."
  else
    herdr-app status | grep -q '"voice-agent"' || herdr-app do mod.open --name voice-agent >/dev/null
    say "The Voice Agent banner is open in Herdr. Drag it where you like, or run again with --dock to build it into the window."
  fi
else
  say "Start Herdr, then run this again: it opens the banner (or, with --dock, builds it into the window)."
fi
[ "$HOOKS" = 1 ] || say "To have Claude Code replies read aloud, run again with --claude-hooks (see README)."
