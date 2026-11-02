import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import { agents, focused, panes, window, theme, exec, hc, home, readTextFile, watchFolder, shared, setShared, nextCommand, props, closeOverlay, openOverlay } from "herdr";

// The scripts and data live in ~/.local/share/herdr-voice-agent (see install.sh):
//   spool/<terminal>.json  replies from the Claude Code hook ({kind: "say" | "stop", id, text})
//   spool/.heartbeat       touched while this mod runs, so the hook hands replies to it
//   state/now.json         what say.py is reading ({job, index, done})
//   voices/*.onnx          Piper voice packs
const DATA = `${home()}/.local/share/herdr-voice-agent`;
const PY = `${DATA}/venv/bin/python`;
const BIN = `${DATA}/bin`;
const SYSTEM_VOICES = ["male1", "female1", "male2", "female2", "male3", "female3"];
const ICON = (name) => `mods/voice-agent/${name}.svg`;
const MAX_CHARS = 6000;
const SHORT = 400; // characters; shorter replies are read as they are

// One sentence at a time (very short ones joined), so the banner shows what is being read
// and Stop lands quickly.
function chunks(text) {
  const out = [];
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]) {
    const last = out.length - 1;
    if (last >= 0 && out[last].trim().length < 40) out[last] += s;
    else out.push(s);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// Copied text that looks like a password, token or key: one "word" mixing letter cases with digits
// or symbols. Read selection never says it aloud.
function looksSecret(text) {
  if (/\s/.test(text) || text.length < 8 || text.length > 200) return false;
  if (/^(sk-|ghp_|gho_|github_pat_|xox[bpa]-|AKIA|eyJ)/.test(text)) return true;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(text)).length;
  return kinds >= 3 && !/^https?:\/\//.test(text);
}

// Starts a program that outlives exec's 30 s limit.
const detach = (cmd, args) => exec("sh", ["-c", 'setsid "$@" </dev/null >/dev/null 2>&1 &', "sh", cmd, ...args]);

export default class VoiceAgent extends View {
  init(_props, cx) {
    this.jobs = [];       // { terminal, sentences } waiting
    this.current = null;  // { id, terminal, sentences, index } being read
    this.held = {};       // terminal -> sentences paused by mute or that agent's button
    this.seen = {};       // terminal -> last spool event handled
    this.packs = [];      // installed Piper voice names
    this.mic = "idle";    // idle | recording | transcribing
    this.heard = null;    // { text, to } after a spoken prompt was sent
    this.clipOk = true;
    this.clipLast = {};
    this.lastSpoken = "";
    this.lastTerminal = null;
    this.lastReply = null;  // { terminal, text, summarized } for Read all
    this.pending = {};      // terminal -> reply id being summarized
    this.ready = true;

    cx.spawn(async (cx) => {
      const r = await exec("mkdir", ["-p", `${DATA}/spool`, `${DATA}/state`, `${DATA}/voices`]).catch(() => null);
      this.ready = Boolean(r && (await exec("test", ["-x", PY]).then((t) => t.code === 0, () => false)));
      cx.notify();
      await this.beat();
      await this.loadPacks();
      await this.scan(cx, false); // what was waiting before Herdr started stays unsaid
      cx.spawn(async (cx) => {
        for (;;) {
          await watchFolder(`${DATA}/state`);
          await this.progress(cx);
        }
      });
      for (;;) {
        await watchFolder(`${DATA}/spool`);
        await this.scan(cx, true);
      }
    });
    cx.timer.every(20000, () => { this.beat(); });
    cx.timer.every(1000, (cx) => {
      if (shared("voice-agent.select") && !this.polling) cx.spawn(async (cx) => this.pollSelection(cx));
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "stop") this.stop(cx);
        else if (c === "mute") this.toggleMute(cx);
        else if (c === "select") this.toggleSelect(cx);
        else if (c === "talk") this.talk(cx);
        else if (c === "full") this.readAll(cx);
        else if (c === "summary") this.toggleMode(cx);
        cx.notify();
      }
    });
  }

  async close() {
    await exec("rm", ["-f", `${DATA}/spool/.heartbeat`]).catch(() => {});
    if (this.current) await exec(PY, [`${BIN}/say.py`, "--stop"]).catch(() => {});
    if (this.mic === "recording") await exec(PY, [`${BIN}/listen.py`, "cancel"]).catch(() => {});
  }

  beat() {
    return exec("touch", [`${DATA}/spool/.heartbeat`]).catch(() => {});
  }

  async loadPacks() {
    const names = await fs.readdir(`${DATA}/voices`).catch(() => []);
    this.packs = names.filter((n) => n.endsWith(".onnx") && names.includes(`${n}.json`)).map((n) => n.slice(0, -5)).sort();
  }

  // ---- replies from the hook ----

  async scan(cx, speak) {
    const names = await fs.readdir(`${DATA}/spool`).catch(() => []);
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      let ev;
      try { ev = JSON.parse(await readTextFile(`${DATA}/spool/${name}`)); } catch { continue; }
      if (!ev?.id || !ev.terminal || this.seen[ev.terminal] === ev.id) continue;
      this.seen[ev.terminal] = ev.id;
      if (!speak) continue;
      if (ev.kind === "stop") this.stop(cx, ev.terminal);
      else if (ev.kind === "say" && ev.text) this.reply(ev, cx);
    }
  }

  // Long replies are read as a Haiku summary (voice-agent.mode "summary", the default); Read all reads
  // the whole reply. If the summary fails, the first two sentences stand in for it.
  reply(ev, cx) {
    const { terminal, text, raw } = ev;
    const summarize = (shared("voice-agent.mode") ?? "summary") === "summary" && Boolean(raw) && text.length > SHORT;
    this.lastReply = { terminal, text, summarized: summarize };
    if (!summarize) return this.say(terminal, text, cx);
    this.pending[terminal] = ev.id;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(PY, [`${BIN}/summarize.py`, raw]).catch(() => null);
      if (this.pending[terminal] !== ev.id) return; // stopped, or a newer reply came in
      delete this.pending[terminal];
      const summary = r?.code === 0 ? r.stdout.trim() : "";
      this.say(terminal, summary || `${chunks(text).slice(0, 2).join(" ")} The full reply is on screen.`, cx, true);
    });
  }

  readAll(cx) {
    const last = this.lastReply;
    if (!last) return;
    this.stop(cx, last.terminal);
    this.lastReply = { ...last, summarized: false };
    this.say(last.terminal, last.text, cx);
  }

  toggleMode(cx) {
    setShared("voice-agent.mode", (shared("voice-agent.mode") ?? "summary") === "summary" ? "full" : "summary");
    cx.notify();
  }

  // While muted (or that agent is off) the newest reply waits in `held` until it's turned back on.
  say(terminal, text, cx, summary = false) {
    const sentences = chunks(text.slice(0, MAX_CHARS));
    if (!sentences.length) return;
    if (terminal !== "selection") this.lastTerminal = terminal;
    if (this.silenced(terminal)) {
      if (terminal !== "selection") this.held[terminal] = sentences;
      cx.notify();
      return;
    }
    this.jobs.push({ terminal, sentences, summary });
    this.next(cx);
  }

  // ---- the reader (say.py runs one job at a time and reports progress in state/now.json) ----

  next(cx) {
    if (this.current || !this.jobs.length) return cx.notify();
    const job = this.jobs.shift();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.current = { ...job, id, index: 0 };
    cx.notify();
    cx.spawn(async () => {
      await this.loadPacks();
      if (this.current?.id !== id) return; // stopped while looking for voice packs
      const spec = { job: id, terminal: job.terminal, sentences: job.sentences,
        voice: this.voiceFor(job.terminal), speed: Number(shared("voice-agent.speed") ?? 1) };
      await detach(PY, [`${BIN}/say.py`, "--job", JSON.stringify(spec)]).catch(() => {});
    });
  }

  async progress(cx) {
    let now;
    try { now = JSON.parse(await readTextFile(`${DATA}/state/now.json`)); } catch { return; }
    if (!this.current || now?.job !== this.current.id) return;
    if (now.done) {
      this.current = null;
      this.next(cx);
    } else {
      this.current.index = now.index;
      cx.notify();
    }
  }

  // Without a terminal: everything. With one: only what that terminal asked to say. Nothing resumes.
  stop(cx, terminal) {
    const mine = (t) => !terminal || t === terminal;
    this.jobs = this.jobs.filter((j) => !mine(j.terminal));
    for (const t of Object.keys(this.held)) if (mine(t)) delete this.held[t];
    for (const t of Object.keys(this.pending)) if (mine(t)) delete this.pending[t];
    if (this.current && mine(this.current.terminal)) {
      const id = this.current.id;
      this.current = null;
      cx.spawn(async (cx) => {
        await exec(PY, [`${BIN}/say.py`, "--stop", id]).catch(() => {});
        this.next(cx);
      });
    }
    cx.notify();
  }

  // Like stop, but keeps the sentences (from the one being read) to resume later.
  hold(cx, terminal) {
    const kept = {};
    const keep = (t, sentences) => { if (t !== "selection" && (!terminal || t === terminal)) (kept[t] ??= []).push(...sentences); };
    if (this.current) keep(this.current.terminal, this.current.sentences.slice(Math.max(0, this.current.index)));
    for (const j of this.jobs) keep(j.terminal, j.sentences);
    this.stop(cx, terminal);
    Object.assign(this.held, kept);
  }

  resume(cx, terminal) {
    for (const [t, sentences] of Object.entries(this.held)) {
      if ((terminal && t !== terminal) || this.silenced(t)) continue;
      delete this.held[t];
      this.jobs.push({ terminal: t, sentences });
    }
    this.next(cx);
  }

  silenced(terminal) {
    return Boolean(shared("voice-agent.muted")) || this.isOff(terminal);
  }

  // voice-agent.voices: { default?, <terminal>? } of "piper:<pack>" | "system:<type>". Without a choice,
  // agents share the first voice pack, or get a system voice each.
  voiceFor(terminal) {
    const chosen = shared("voice-agent.voices") ?? {};
    const pick = chosen[terminal] ?? chosen.default;
    if (pick && (!pick.startsWith("piper:") || this.packs.includes(pick.slice(6)))) return pick;
    if (this.packs.length) return `piper:${this.packs[0]}`;
    const n = parseInt(terminal.replace(/\D/g, ""), 10) || 0;
    return `system:${SYSTEM_VOICES[n % SYSTEM_VOICES.length]}`;
  }

  isOff(terminal) {
    return Boolean((shared("voice-agent.off") ?? {})[terminal]);
  }

  toggleAgent(terminal, cx) {
    const off = { ...(shared("voice-agent.off") ?? {}) };
    off[terminal] = !off[terminal];
    setShared("voice-agent.off", off);
    if (off[terminal]) this.hold(cx, terminal);
    else this.resume(cx, terminal);
  }

  toggleMute(cx) {
    const muted = !shared("voice-agent.muted");
    setShared("voice-agent.muted", muted);
    if (muted) this.hold(cx);
    else this.resume(cx);
  }

  // ---- talking to an agent ----

  // The agent being looked at, else the one that spoke last, else the first.
  target() {
    const list = agents();
    const f = focused();
    const has = (t) => t && list.some((a) => a.address === t);
    if (has(f?.agent)) return f.agent;
    if (has(f?.terminal)) return f.terminal;
    if (has(this.lastTerminal)) return this.lastTerminal;
    return list[0]?.address ?? null;
  }

  talk(cx) {
    if (this.mic === "recording") return this.send(cx);
    if (this.mic !== "idle") return;
    const to = this.target();
    if (!to) {
      this.heard = { text: "No agent to talk to", to: null };
      return cx.notify();
    }
    this.stop(cx); // don't listen to ourselves
    this.mic = "recording";
    this.micTarget = to;
    this.heard = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(PY, [`${BIN}/listen.py`, "start"]).catch(() => null);
      if (r?.code !== 0) {
        let why = "";
        try { why = JSON.parse(r?.stdout ?? "").error ?? ""; } catch { /* no details */ }
        this.mic = "idle";
        this.heard = { text: why || "Couldn't start the microphone", to: null };
        cx.notify();
      }
    });
  }

  send(cx) {
    this.mic = "transcribing";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(PY, [`${BIN}/listen.py`, "stop"]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      let text = "";
      try { text = JSON.parse(r?.stdout ?? "").text ?? ""; } catch { /* nothing heard */ }
      let sent = null;
      if (text) sent = await hc(["send", "--json", this.micTarget, text]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      const failed = sent && sent.code !== 0;
      this.log({ to: this.micTarget, text, listen: { code: r?.code, stderr: r?.stderr?.slice(-500) },
        send: sent && { code: sent.code, stdout: sent.stdout.slice(-500), stderr: sent.stderr.slice(-500) } });
      this.heard = !text ? { text: r?.code === 0 ? "Didn't catch that" : "Couldn't transcribe the recording", to: null }
        : failed ? { text: `Couldn't send "${text}": ${(sent.stderr || sent.stdout).trim().split("\n").pop()}`, to: null }
        : { text, to: this.micTarget };
      this.mic = "idle";
      cx.notify();
      cx.timer.after(10000, (cx) => { this.heard = null; cx.notify(); });
    });
  }

  // state/talk.log: the last 100 recordings, one JSON line each, for troubleshooting. Only this
  // user can read it.
  log(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    const script = 'umask 077; printf "%s\\n" "$1" >> "$2" && tail -n 100 "$2" > "$2.tmp" && mv "$2.tmp" "$2"';
    exec("sh", ["-c", script, "sh", line, `${DATA}/state/talk.log`]).catch(() => {});
  }

  cancelTalk(cx) {
    this.mic = "idle";
    cx.spawn(async () => { await exec(PY, [`${BIN}/listen.py`, "cancel"]).catch(() => {}); });
  }

  // ---- reading highlighted or copied text ----

  toggleSelect(cx) {
    const on = !shared("voice-agent.select");
    setShared("voice-agent.select", on);
    this.clipLast = {};
    this.clipOk = true;
    if (!on) this.stop(cx, "selection");
  }

  // Only text selected or copied in Herdr's terminals is read: Herdr's window must have been active
  // since the last check (so it wasn't another app's selection), and the text must be on the screen
  // or in the recent history of a terminal in the shown tab (so not a side panel or another app).
  async pollSelection(cx) {
    this.polling = true;
    const active = Boolean(window()?.active);
    const ours = active && this.wasActive;
    this.wasActive = active;
    try {
      // System Python: GTK's bindings come with the desktop, not the venv.
      const r = await exec("env", ["GDK_BACKEND=x11", "python3", "-I", `${BIN}/clipread.py`]).catch(() => null);
      let now;
      try { now = JSON.parse(r?.stdout ?? ""); } catch { now = null; }
      if (Boolean(now) !== this.clipOk) { this.clipOk = Boolean(now); cx.notify(); }
      if (!now) return;
      for (const which of ["primary", "clipboard"]) {
        const text = (now[which] ?? "").trim();
        const first = !(which in this.clipLast);
        const changed = text !== this.clipLast[which];
        this.clipLast[which] = text;
        if (first || !changed || !text || !ours || text === this.lastSpoken || shared("voice-agent.muted") || looksSecret(text)) continue;
        if (!(await this.inTerminal(text))) continue;
        this.lastSpoken = text;
        this.stop(cx, "selection");
        this.say("selection", text, cx);
      }
    } finally {
      this.polling = false;
    }
  }

  async inTerminal(text) {
    const needle = text.replace(/\s+/g, ""); // terminals wrap lines where the selection doesn't
    const f = focused();
    const shown = panes().filter((p) => p.tab === f?.tab && p.terminal).map((p) => p.terminal);
    for (const terminal of new Set([f?.terminal, ...shown].filter(Boolean))) {
      const r = await hc(["read", terminal, "--lines", "300"]).catch(() => null);
      if (r?.code === 0 && r.stdout.replace(/\s+/g, "").includes(needle)) return true;
    }
    return false;
  }

  // ---- the banner ----

  render() {
    const t = theme();
    const muted = Boolean(shared("voice-agent.muted"));
    const select = Boolean(shared("voice-agent.select"));
    const list = agents();
    const who = (terminal) => terminal === "selection" ? "Selection" : (list.find((a) => a.address === terminal)?.space_name ?? terminal);
    const waiting = Object.keys(this.held).filter((k) => this.held[k].length);

    const chip = (id, on, icon, label, tip, click, color) => h_flex().id(id).flex_shrink_0().gap(6).items_center()
      .px(9).h(22).rounded(11).border(1).cursor_pointer().tooltip(tip)
      .border_color(on ? (color ?? t.accent) : t.border)
      .bg(on ? (color ?? t.accent) : t.surface)
      .text_color(on ? t.accent_foreground : t.muted)
      .hover((s) => s.bg(on ? (color ?? t.accent) : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press on the window elsewhere drags it
      .on_click((_e, cx) => { click(cx); cx.notify(); })
      .child(svg(ICON(icon)).size(12))
      .when(Boolean(label), (el) => el.child(label));

    const line = (accent, name, text) => h_flex().flex_1().min_w(0).gap(8).items_center()
      .when(Boolean(accent), (el) => el.child(accent))
      .when(Boolean(name), (el) => el.child(div().flex_shrink_0().font_semibold().text_color(t.foreground).child(name)))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(text));
    const bars = div().flex_shrink_0().text_color(t.accent).frames(["▁▃▅▇", "▃▅▇▅", "▅▇▅▃", "▇▅▃▁", "▅▃▁▃", "▃▁▃▅"], 140);
    const dot = div().flex_shrink_0().size(8).rounded(4).bg(t.blocked).loop("opacity", { from: 0.3, to: 1, period: 900 });

    const cur = this.current;
    const pendingFor = Object.keys(this.pending)[0];
    const summaries = (shared("voice-agent.mode") ?? "summary") === "summary";
    let status;
    if (!this.ready) status = line(null, null, "Run install.sh from the herdr-voice-agent repo to set up voices and the microphone");
    else if (this.mic === "recording") status = line(dot, `To ${who(this.micTarget)}`, "Listening… click Send when you're done");
    else if (this.mic === "transcribing") status = line(div().flex_shrink_0().text_color(t.accent).frames(["◐", "◓", "◑", "◒"], 120), null, "Turning your words into text…");
    else if (cur) status = line(bars, `${who(cur.terminal)}${cur.summary ? " · summary" : ""}`, cur.sentences[Math.max(0, cur.index)] ?? "");
    else if (pendingFor) status = line(div().flex_shrink_0().text_color(t.accent).frames(["◐", "◓", "◑", "◒"], 120), who(pendingFor), "Summarizing the reply…");
    else if (this.heard) status = line(null, this.heard.to ? `You → ${who(this.heard.to)}` : null, this.heard.text);
    else {
      const idle = waiting.length
        ? `Paused: ${waiting.map(who).join(", ")}. Turn ${muted ? "speech" : "them"} back on to continue`
        : muted ? "Speech muted: replies won't be read" : "Speech on: highlighted agents are read aloud";
      status = div().flex_1().min_w(0).truncate().text_color(waiting.length ? t.muted : t.dim).child(idle);
    }

    const recording = this.mic === "recording";
    // Two rows: the controls, then what's being read (or heard) across the full width.
    const controls = h_flex().gap(8).items_center()
      .child(chip("mute", !muted, muted ? "speaker-off" : "speaker", muted ? "Muted" : "Speech",
        muted ? "Turn speech back on" : "Mute all speech", (cx) => this.toggleMute(cx)))
      .child(chip("talk", recording, "mic", recording ? "Send" : "Talk",
        recording ? "Stop listening and send what you said" : `Say a prompt to ${who(this.target() ?? "") || "an agent"}`,
        (cx) => this.talk(cx), t.blocked))
      .when(recording, (el) => el.child(chip("cancel", false, "stop", "Cancel", "Throw this recording away", (cx) => this.cancelTalk(cx))))
      .when(Boolean(cur) && !recording, (el) => el.child(chip("stop", false, "stop", "Stop", "Stop reading now", (cx) => this.stop(cx))))
      .when(Boolean(this.lastReply?.summarized) && !recording, (el) => el.child(chip("full", false, "play", "Read all",
        `Read ${who(this.lastReply.terminal)}'s whole reply instead of the summary`, (cx) => this.readAll(cx))))
      .child(div().flex_1())
      .children(list.map((a) => chip(`agent-${a.address}`, !this.isOff(a.address), this.isOff(a.address) ? "speaker-off" : "speaker",
        a.space_name, this.isOff(a.address) ? `Read ${a.space_name}'s replies aloud` : `Stop reading ${a.space_name}'s replies`,
        (cx) => this.toggleAgent(a.address, cx))))
      .child(div().w(1).h(16).flex_shrink_0().bg(t.border))
      .child(chip("select", select, "select", "Read selection",
        select ? "Stop reading highlighted text" : "Read terminal text aloud when you highlight or copy it in Herdr", (cx) => this.toggleSelect(cx)))
      .when(select && !this.clipOk, (el) => el.child(div().flex_shrink_0().text_color(t.blocked).child("can't read the selection")))
      .child(chip("mode", summaries, "summary", summaries ? "Summaries" : "Full replies",
        summaries ? "Long replies are summarized before reading. Click to read them in full" : "Replies are read in full. Click to summarize long ones",
        (cx) => this.toggleMode(cx)))
      .child(chip("voices", false, "voice", "Voices", "Pick voices and speed, get voice packs",
        () => openOverlay({ mod: "voice-agent-voices", kind: "dialog", width: 620, height: 0.75 })))
      .child(div().id("close").flex_shrink_0().px(4).text_color(t.dim).cursor_pointer().tooltip("Close (reopen: herdr-app do mod.open --name voice-agent)")
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(props().overlay))
        .child("✕"));

    return v_flex().id("root").size_full().px(12).py(7).gap(6).justify_center().text_size(12)
      .bg(cur || recording ? t.selected : t.chrome)
      .child(controls)
      .child(h_flex().h(20).px(2).items_center().text_size(13).child(status));
  }
}
