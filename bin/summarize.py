#!/usr/bin/env python3
"""Turns an agent's reply into a short spoken summary with Claude Haiku.

  summarize.py REPLY     prints the summary; exits 1 when it can't make one

Runs `claude -p` with hooks, tools and session saving off, so the summary costs one small Haiku
call and doesn't start another read-aloud. Env: HERDR_SPEECH_SUMMARY_MODEL (default "haiku"),
CLAUDE_BIN (default: claude on PATH, else ~/.local/bin/claude).
"""
import os
import shutil
import subprocess
import sys

PROMPT = (
    "You turn a coding agent's reply into a short spoken summary for someone listening, not reading. "
    "Plain sentences only: no markdown, lists, code, file paths, URLs or symbols. "
    "At most three sentences and 60 words. Lead with the outcome. "
    "Keep anything the listener must decide or do, and any question the agent asks. "
    "Keep the agent's first-person voice and don't change who does what. "
    "Use the language the reply is written in. Output only the summary."
)
DATA = os.environ.get("HERDR_SPEECH_HOME", os.path.expanduser("~/.local/share/herdr-speech"))


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    claude = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
    cmd = [claude, "-p", "--model", os.environ.get("HERDR_SPEECH_SUMMARY_MODEL", "haiku"),
           "--no-session-persistence", "--settings", '{"disableAllHooks": true}', "--tools", "",
           "--system-prompt", PROMPT]
    env = dict(os.environ, HERDR_SPEECH_SUMMARIZING="1")  # speak-reply.py ignores this session
    os.makedirs(DATA, exist_ok=True)
    try:
        # Run outside any project so no CLAUDE.md is loaded; stay under the banner's 30 s limit.
        r = subprocess.run(cmd, input=sys.argv[1], capture_output=True, text=True, timeout=25, cwd=DATA, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        sys.exit(f"summary failed: {e}")
    summary = r.stdout.strip()
    if r.returncode != 0 or not summary:
        sys.exit(f"summary failed: {r.stderr.strip()[-300:]}")
    print(summary)


if __name__ == "__main__":
    main()
