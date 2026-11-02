#!/usr/bin/env python3
"""Claude Code hooks: read Claude's last reply aloud.

Stop hook:              speak-reply.py
UserPromptSubmit hook:  speak-reply.py --stop

When the Herdr "voice-agent" mod is running (its heartbeat is fresh), the reply is
handed to it through ~/.local/share/herdr-voice-agent/spool/<terminal>.json and the mod
does the speaking (voices, banner, mute, per-agent on/off). Otherwise spd-say is used
directly.

The mod gets the full reply too ("raw"), so it can have it summarized before reading.

Optional env vars: SPEAK_VOICE (spd-say voice type, e.g. male1, female2),
SPEAK_RATE (-100..100), SPEAK_MAX_CHARS (default 6000).
"""
import json
import os
import re
import subprocess
import sys
import time

DATA = os.environ.get("HERDR_VOICE_HOME", os.path.expanduser("~/.local/share/herdr-voice-agent"))
SPOOL = os.path.join(DATA, "spool")
HEARTBEAT = os.path.join(SPOOL, ".heartbeat")


def last_reply(payload):
    text = payload.get("last_assistant_message")
    if isinstance(text, str) and text.strip():
        return text
    path = payload.get("transcript_path")
    if not path or not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        msg = entry.get("message") or {}
        if entry.get("type") != "assistant" or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        parts = [c.get("text", "") for c in content or [] if c.get("type") == "text"]
        if any(p.strip() for p in parts):
            return "\n".join(parts)
    return ""


def to_speech(md):
    t = re.sub(r"```.*?```", " Code block omitted. ", md, flags=re.S)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)          # links/images -> text
    t = re.sub(r"https?://\S+", "", t)                         # bare URLs
    t = re.sub(r"`([^`]*)`", r"\1", t)                         # inline code
    t = re.sub(r"^\s*\|?[-:| ]+\|[-:| ]*$", "", t, flags=re.M)  # table separators
    t = t.replace("|", ", ")
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)        # headings
    t = re.sub(r"^\s*([-*+]|\d+\.)\s+", "", t, flags=re.M)     # list markers
    t = re.sub(r"^\s*>\s?", "", t, flags=re.M)                 # blockquotes
    t = re.sub(r"(\*\*|__|\*|_|~~)(\S.*?\S|\S)\1", r"\2", t)   # emphasis
    t = re.sub(r"\s*\n\s*", ". ", t.strip())
    t = re.sub(r"(\.\s*){2,}", ". ", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def mod_running():
    try:
        return time.time() - os.path.getmtime(HEARTBEAT) < 60
    except OSError:
        return False


def hand_to_mod(event):
    terminal = os.environ.get("HC_TERMINAL_ID")
    if not terminal or not mod_running():
        return False
    event = dict(event, terminal=terminal, id=f"{time.time_ns()}")
    os.umask(0o077)  # replies stay readable by this user only
    tmp = os.path.join(SPOOL, f".{terminal}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(event, f)
    os.replace(tmp, os.path.join(SPOOL, f"{terminal}.json"))
    return True


def main():
    if os.environ.get("HERDR_VOICE_SUMMARIZING"):
        return  # the summarizer's own claude -p session
    if "--stop" in sys.argv:
        if not hand_to_mod({"kind": "stop"}):
            subprocess.run(["spd-say", "-C"], check=False)
        return
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    raw = last_reply(payload)
    text = to_speech(raw)
    if not text:
        return
    def cut(limit):
        return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + ". Message truncated."

    if hand_to_mod({"kind": "say", "text": cut(int(os.environ.get("SPEAK_MAX_CHARS", "6000"))), "raw": raw[:12000]}):
        return
    text = cut(1500)  # no banner, so no summary or Stop button: keep it short
    cmd = ["spd-say"]
    if os.environ.get("SPEAK_VOICE"):
        cmd += ["-t", os.environ["SPEAK_VOICE"]]
    if os.environ.get("SPEAK_RATE"):
        cmd += ["-r", os.environ["SPEAK_RATE"]]
    subprocess.run(cmd + ["--", text], check=False)


if __name__ == "__main__":
    main()
