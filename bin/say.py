#!/usr/bin/env python3
"""Reads sentences aloud for the Herdr voice-agent mod, one job at a time.

  say.py --job JSON      speak a job: {"job", "terminal", "sentences": [...], "voice", "speed"}
  say.py --stop [JOB]    stop that job (default: the one being spoken)
  say.py --preview VOICE [TEXT]

voice: "piper:<name>" (a voice pack in voices/) or "system:<type>" (spd-say: male1, female2, ...).
Progress goes to state/now.json ({"job", "index", "pid", "done"}), which the mod watches.
"""
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import wave

DATA = os.environ.get("HERDR_VOICE_HOME", os.path.expanduser("~/.local/share/herdr-voice-agent"))
STATE = os.path.join(DATA, "state")
VOICES = os.path.join(DATA, "voices")
NOW = os.path.join(STATE, "now.json")

stopping = threading.Event()
player = None  # the audio process playing now


def write_now(status):
    os.makedirs(STATE, exist_ok=True)
    tmp = NOW + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(status, f)
    os.replace(tmp, NOW)


def play_command(path):
    for cmd in (["pw-play", path], ["paplay", path], ["aplay", "-q", path]):
        if shutil.which(cmd[0]):
            return cmd
    raise RuntimeError("no audio player found (pw-play, paplay or aplay)")


def on_term(*_):
    stopping.set()
    if player and player.poll() is None:
        player.terminate()
    subprocess.run(["spd-say", "-C"], check=False, stderr=subprocess.DEVNULL)


def speak_system(job, report):
    voice = job["voice"].split(":", 1)[1] or "male1"
    rate = str(max(-100, min(100, round((job.get("speed", 1.0) - 1.0) * 100))))
    global player
    for i, sentence in enumerate(job["sentences"]):
        if stopping.is_set():
            return
        report(i)
        player = subprocess.Popen(["spd-say", "-w", "-t", voice, "-r", rate, "--", sentence])
        player.wait()


def piper_model(name):
    if not name or os.path.basename(name) != name or name.startswith("."):
        raise ValueError(f"not a voice pack name: {name!r}")
    path = os.path.join(VOICES, f"{name}.onnx")
    if not (os.path.exists(path) and os.path.exists(path + ".json")):
        raise FileNotFoundError(f"voice pack {name} is not in {VOICES}")
    return path


def speak_piper(job, report):
    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(piper_model(job["voice"].split(":", 1)[1]))
    config = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, job.get("speed", 1.0))))
    tmp = tempfile.mkdtemp(prefix="herdr-voice-agent-")
    ready = queue.Queue()

    # Synthesize ahead while the previous sentence plays, so there are no gaps.
    def synthesize():
        for i, sentence in enumerate(job["sentences"]):
            if stopping.is_set():
                break
            path = os.path.join(tmp, f"{i}.wav")
            with wave.open(path, "wb") as w:
                voice.synthesize_wav(sentence, w, syn_config=config)
            ready.put(path)
        ready.put(None)

    threading.Thread(target=synthesize, daemon=True).start()
    global player
    try:
        for i in range(len(job["sentences"])):
            path = ready.get()
            if path is None or stopping.is_set():
                return
            report(i)
            player = subprocess.Popen(play_command(path))
            player.wait()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def pid_file(job_id):
    return os.path.join(STATE, f"job-{job_id}.pid")


def speak(job):
    report = lambda i: write_now({"job": job["job"], "index": i, "pid": os.getpid(), "done": False})
    os.makedirs(STATE, exist_ok=True)
    with open(pid_file(job["job"]), "w") as f:
        f.write(str(os.getpid()))
    try:
        if job["voice"].startswith("piper:"):
            try:
                speak_piper(job, report)
                return
            except Exception as e:  # missing voice pack or Piper: fall back to the system voice
                print(f"piper failed, using the system voice: {e}", file=sys.stderr)
                job = dict(job, voice="system:male1")
        speak_system(job, report)
    finally:
        write_now({"job": job["job"], "index": -1, "pid": None, "done": True})
        try:
            os.unlink(pid_file(job["job"]))
        except OSError:
            pass


# By job id, so stopping one job can't hit the next one if it has already started.
def stop(job_id=None):
    try:
        if job_id:
            with open(pid_file(job_id)) as f:
                pid = int(f.read())
        else:
            with open(NOW, encoding="utf-8") as f:
                pid = json.load(f).get("pid")
        if pid:
            os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    subprocess.run(["spd-say", "-C"], check=False, stderr=subprocess.DEVNULL)


def main():
    signal.signal(signal.SIGTERM, on_term)
    args = sys.argv[1:]
    if args[:1] == ["--stop"]:
        stop(args[1] if len(args) > 1 else None)
    elif args[:1] == ["--preview"] and len(args) >= 2:
        name = args[1].split(":", 1)[1].replace("_", " ")
        text = args[2] if len(args) > 2 else f"Hello, I am {name}. This is how I sound when I read a reply to you."
        speak({"job": "preview", "sentences": [text], "voice": args[1], "speed": float(os.environ.get("SPEED", "1"))})
    elif args[:1] == ["--job"] and len(args) == 2:
        speak(json.loads(args[1]))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
