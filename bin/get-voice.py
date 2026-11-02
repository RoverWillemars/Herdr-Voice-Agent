#!/usr/bin/env python3
"""Downloads Piper voice packs into the voice-agent mod's voices folder.

  get-voice.py NAME [NAME...]   e.g. en_US-lessac-medium, en_GB-alba-medium, nl_NL-ronnie-medium
  get-voice.py --list [FILTER]  every voice in the Piper catalog (https://rhasspy.github.io/piper-samples/)

A voice pack is a NAME.onnx file with its NAME.onnx.json next to it. Any pack from the catalog,
or one you trained yourself, works when both files are in the voices folder.
"""
import hashlib
import json
import os
import sys
import urllib.request

DATA = os.environ.get("HERDR_VOICE_HOME", os.path.expanduser("~/.local/share/herdr-voice-agent"))
VOICES = os.path.join(DATA, "voices")
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/"


def catalog():
    with urllib.request.urlopen(BASE + "voices.json", timeout=30) as r:
        return json.load(r)


def download(url, dest, md5):
    part = dest + ".part"
    digest = hashlib.md5()
    with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
            digest.update(chunk)
    if md5 and digest.hexdigest() != md5:
        os.unlink(part)
        sys.exit(f"{os.path.basename(dest)}: download is corrupt or was tampered with (checksum mismatch)")
    os.replace(part, dest)


def get(name, voices):
    entry = voices.get(name)
    if not entry:
        sys.exit(f"{name}: not in the Piper catalog (see get-voice.py --list)")
    os.makedirs(VOICES, exist_ok=True)
    files = sorted(entry["files"], key=lambda p: p.endswith(".onnx"))  # model last: it marks the pack complete
    for path in files:
        if path.endswith((".onnx", ".onnx.json")):
            download(BASE + path, os.path.join(VOICES, os.path.basename(path)), entry["files"][path].get("md5_digest"))
    print(f"{name}: installed in {VOICES}")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    voices = catalog()
    if args[0] == "--list":
        needle = args[1].lower() if len(args) > 1 else ""
        for name in sorted(voices):
            if needle in name.lower():
                print(name)
        return
    for name in args:
        get(name, voices)


if __name__ == "__main__":
    main()
