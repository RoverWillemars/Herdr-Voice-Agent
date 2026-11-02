#!/usr/bin/env python3
"""Claude Code hooks: read Claude's last reply, and anything it waits on, aloud.

Stop hook:                             speak-reply.py
PreToolUse hook (AskUserQuestion):     speak-reply.py --ask      the question and its options
Notification hook:                     speak-reply.py --notify   e.g. a permission prompt
UserPromptSubmit hook, and PostToolUse
hook (AskUserQuestion):                speak-reply.py --stop     you answered: stop talking

A question or a permission prompt pauses the turn, so the Stop hook doesn't run until it's
answered; --ask and --notify read those while they wait.

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
    t = re.sub(r"([!?:;,])\. ", r"\1 ", t)
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


def question_text(payload):
    """AskUserQuestion, spoken: (questions with option labels, the same with option descriptions)."""
    questions = (payload.get("tool_input") or {}).get("questions") or []
    short, full = [], []
    for n, q in enumerate(questions, 1):
        ask = (f"Question {n} of {len(questions)}: " if len(questions) > 1 else "Question: ") + q.get("question", "").strip()
        if q.get("multiSelect"):
            ask += " You can pick more than one."
        short.append(ask)
        full.append(ask)
        for i, option in enumerate(q.get("options") or [], 1):
            label = re.sub(r"\s*\((recommended)\)", r", \1", option.get("label", ""), flags=re.I).strip()
            short.append(f"Option {i}: {label}.")
            full.append(f"Option {i}: {label}. {option.get('description', '').strip()}".strip())
    return to_speech("\n".join(short)), to_speech("\n".join(full))


def text_before_question(payload):
    """What the agent wrote just before asking: the text entries in the transcript right before
    the AskUserQuestion call (thinking and bookkeeping entries skipped)."""
    path = payload.get("transcript_path")
    if not path or not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()[-200:]
    parts, seen_question = [], False
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        msg = entry.get("message") or {}
        if entry.get("type") not in ("assistant", "user"):
            continue  # snapshots, request records
        content = msg.get("content")
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content or []
        kinds = {b.get("type") for b in blocks if isinstance(b, dict)}
        if entry["type"] == "assistant" and kinds <= {"thinking", "redacted_thinking"}:
            continue
        if entry["type"] == "assistant" and "tool_use" in kinds and not parts and not seen_question:
            seen_question = True  # the question itself
            continue
        if entry["type"] == "assistant" and kinds == {"text"}:
            parts.insert(0, "\n".join(b.get("text", "") for b in blocks))
            continue
        break  # an earlier tool call or the person's message: the turn's text before the question ends here
    return "\n".join(parts).strip()


def notification_text(payload):
    """A permission prompt or another request for the person; not the "waiting for your input"
    reminder, since the Stop hook already read that reply."""
    kind = payload.get("notification_type") or ""
    message = (payload.get("message") or "").strip()
    if kind in ("idle_prompt", "auth_success") or (not kind and "waiting for your input" in message.lower()):
        return ""
    return to_speech(message)


def speak_directly(text):
    cmd = ["spd-say"]
    if os.environ.get("SPEAK_VOICE"):
        cmd += ["-t", os.environ["SPEAK_VOICE"]]
    if os.environ.get("SPEAK_RATE"):
        cmd += ["-r", os.environ["SPEAK_RATE"]]
    subprocess.run(cmd + ["--", text], check=False)


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
    if "--ask" in sys.argv or "--notify" in sys.argv:
        short, full = question_text(payload) if "--ask" in sys.argv else (notification_text(payload), "")
        if not short:
            return
        # The banner reads the explanation before the question first ("intro", summarized when long,
        # from "raw"), then the question and option labels; Read all adds the options' descriptions.
        raw = text_before_question(payload) if "--ask" in sys.argv else ""
        intro = to_speech(raw)
        event = {"kind": "say", "text": short, "full": f"{intro} {full or short}".strip(), "intro": intro, "raw": raw[:12000]}
        if not hand_to_mod(event):
            speak_directly(f"{intro} {short}".strip()[:1500])
        return
    raw = last_reply(payload)
    text = to_speech(raw)
    if not text:
        return
    def cut(limit):
        return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + ". Message truncated."

    if hand_to_mod({"kind": "say", "text": cut(int(os.environ.get("SPEAK_MAX_CHARS", "6000"))), "raw": raw[:12000]}):
        return
    speak_directly(cut(1500))  # no banner, so no summary or Stop button: keep it short


if __name__ == "__main__":
    main()
