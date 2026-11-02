#!/usr/bin/env python3
"""Microphone input for the Herdr speech mod.

  listen.py start     start recording (prints {"mic": <source>})
  listen.py stop      stop recording and transcribe (prints {"text": ...})
  listen.py cancel    stop recording and throw it away
  listen.py warmup    download the speech-to-text model ahead of time

Env: HERDR_SPEECH_MIC (a PipeWire/Pulse source name; default: the first one that isn't a
speaker monitor), HERDR_SPEECH_STT_MODEL (faster-whisper model, default "base"),
HERDR_SPEECH_LANGUAGE (e.g. "en", "nl"; default: detected).
"""
import json
import os
import signal
import subprocess
import sys
import time

DATA = os.environ.get("HERDR_SPEECH_HOME", os.path.expanduser("~/.local/share/herdr-speech"))
STATE = os.path.join(DATA, "state")
MODELS = os.path.join(DATA, "models")
WAV = os.path.join(STATE, "recording.wav")
PID = os.path.join(STATE, "recording.pid")
MODEL = os.environ.get("HERDR_SPEECH_STT_MODEL", "base")


class NoMicrophone(Exception):
    pass


def microphone():
    """The source to record from. The default source is sometimes the speakers' monitor, which
    records what's playing, and a sound card's mic jack is listed even with nothing plugged in."""
    if os.environ.get("HERDR_SPEECH_MIC"):
        return os.environ["HERDR_SPEECH_MIC"]
    try:
        out = subprocess.run(["pactl", "-f", "json", "list", "sources"], capture_output=True, text=True).stdout
        sources = json.loads(out)
    except (FileNotFoundError, ValueError):
        return None  # no pactl, or too old for JSON: let the recorder use its default
    plugged, unknown = [], []
    for s in sources:
        if s.get("monitor_source") or s["name"].endswith(".monitor"):
            continue
        port = next((p for p in s.get("ports", []) if p.get("name") == s.get("active_port")), None)
        availability = (port or {}).get("availability", "unknown")
        if availability == "available":
            plugged.append(s["name"])
        elif availability != "not available":
            unknown.append(s["name"])  # USB and Bluetooth mics often don't report a port
    if plugged or unknown:
        return (plugged + unknown)[0]
    raise NoMicrophone("No microphone is connected")


def recorder(mic):
    if subprocess.run(["sh", "-c", "command -v pw-record"], capture_output=True).returncode == 0:
        return ["pw-record", "--rate", "16000", "--channels", "1"] + (["--target", mic] if mic else []) + [WAV]
    return ["parecord", "--rate=16000", "--channels=1", "--file-format=wav"] + ([f"--device={mic}"] if mic else []) + [WAV]


def end_recording(sig):
    try:
        with open(PID) as f:
            pid = int(f.read())
        os.unlink(PID)
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, sig)
        for _ in range(50):  # let it finish writing the file
            os.kill(pid, 0)
            time.sleep(0.05)
    except OSError:
        pass
    return True


def start():
    os.umask(0o077)  # recordings stay readable by this user only
    os.makedirs(STATE, exist_ok=True)
    end_recording(signal.SIGINT)
    try:
        mic = microphone()
    except NoMicrophone as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    proc = subprocess.Popen(recorder(mic), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    with open(PID, "w") as f:
        f.write(str(proc.pid))
    print(json.dumps({"mic": mic}))


def model():
    from faster_whisper import WhisperModel

    return WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=MODELS)


def stop():
    if not end_recording(signal.SIGINT) or not os.path.exists(WAV):
        print(json.dumps({"text": "", "error": "not recording"}))
        return
    segments, _info = model().transcribe(WAV, language=os.environ.get("HERDR_SPEECH_LANGUAGE") or None, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    os.unlink(WAV)
    print(json.dumps({"text": text}))


def cancel():
    end_recording(signal.SIGTERM)
    if os.path.exists(WAV):
        os.unlink(WAV)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "start":
        start()
    elif cmd == "stop":
        stop()
    elif cmd == "cancel":
        cancel()
    elif cmd == "warmup":
        model()
        print(f"speech-to-text model '{MODEL}' is ready")
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
