import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import { agents, theme, exec, home, watchFolder, shared, setShared, props, closeOverlay } from "herdr";

// Opened from the Voice Agent banner's Voices button. Writes the choices to shared state, which the
// banner reads: voice-agent.voices { default?, <terminal>? } and voice-agent.speed.
const DATA = `${home()}/.local/share/herdr-voice-agent`;
const PY = `${DATA}/venv/bin/python`;
const BIN = `${DATA}/bin`;
const ICON = (name) => `mods/voice-agent/${name}.svg`;
const SYSTEM = ["male1", "female1", "male2", "female2"];
const SPEEDS = [0.8, 0.9, 1, 1.15, 1.3];

// A few good Piper voices to start from; any other from the catalog works too.
const SUGGESTED = [
  { name: "en_US-lessac-medium", about: "US English, warm and clear", mb: 63 },
  { name: "en_US-amy-medium", about: "US English, bright", mb: 63 },
  { name: "en_US-ryan-high", about: "US English, deep, best quality", mb: 121 },
  { name: "en_US-joe-medium", about: "US English, relaxed", mb: 63 },
  { name: "en_GB-alba-medium", about: "Scottish English", mb: 63 },
  { name: "en_GB-jenny_dioco-medium", about: "British English", mb: 63 },
  { name: "en_GB-northern_english_male-medium", about: "Northern English", mb: 63 },
  { name: "nl_NL-ronnie-medium", about: "Dutch", mb: 63 },
  { name: "nl_BE-nathalie-medium", about: "Flemish", mb: 63 },
  { name: "de_DE-thorsten-medium", about: "German", mb: 63 },
];

const nice = (id) => {
  const [engine, name] = id.split(":");
  if (engine === "system") return `System ${name.replace(/(\d)/, " $1")}`;
  const [lang, speaker, quality] = name.split("-");
  return `${(speaker ?? name).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} · ${lang}${quality ? ` · ${quality}` : ""}`;
};

export default class VoiceAgentVoices extends View {
  init(_props, cx) {
    this.target = "default";
    this.packs = [];
    this.getting = {};  // pack name -> true while downloading
    this.playing = null;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${DATA}/voices`]).catch(() => {});
      for (;;) {
        await this.load();
        cx.notify();
        await watchFolder(`${DATA}/voices`);
      }
    });
  }

  async load() {
    const names = await fs.readdir(`${DATA}/voices`).catch(() => []);
    this.packs = names.filter((n) => n.endsWith(".onnx") && names.includes(`${n}.json`)).map((n) => n.slice(0, -5)).sort();
    for (const p of this.packs) delete this.getting[p];
  }

  choose(id) {
    const voices = { ...(shared("voice-agent.voices") ?? {}) };
    if (id) voices[this.target] = id;
    else delete voices[this.target];
    setShared("voice-agent.voices", voices);
  }

  preview(id, cx) {
    this.playing = id;
    cx.notify();
    cx.spawn(async (cx) => {
      await exec("env", [`SPEED=${shared("voice-agent.speed") ?? 1}`, PY, `${BIN}/say.py`, "--preview", id]).catch(() => {});
      if (this.playing === id) this.playing = null;
      cx.notify();
    });
  }

  download(name, cx) {
    this.getting[name] = true;
    cx.notify();
    exec("sh", ["-c", 'setsid "$@" </dev/null >/dev/null 2>&1 &', "sh", PY, `${BIN}/get-voice.py`, name]).catch(() => {});
  }

  render() {
    const t = theme();
    const list = agents();
    const voices = shared("voice-agent.voices") ?? {};
    // Without a choice the banner uses the first voice pack (see voiceFor in mods/voice-agent).
    const fallback = voices.default ?? (this.packs.length ? `piper:${this.packs[0]}` : null);
    const current = voices[this.target] ?? fallback;
    const own = this.target !== "default" && Boolean(voices[this.target]);
    const speed = Number(shared("voice-agent.speed") ?? 1);

    const button = (id, label, icon, onClick, primary) => h_flex().id(id).flex_shrink_0().gap(6).items_center().px(10).h(26).rounded(6)
      .cursor_pointer().border(1).border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.solid : t.hover))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(12)))
      .when(Boolean(label), (el) => el.child(label));
    const pill = (id, on, label, onClick) => div().id(id).flex_shrink_0().px(10).py(3).rounded(12).cursor_pointer().border(1)
      .border_color(on ? t.accent : t.border).bg(on ? t.accent : t.surface).text_color(on ? t.accent_foreground : t.muted)
      .hover((s) => s.bg(on ? t.accent : t.hover))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(label);
    const heading = (text) => div().pt(10).text_size(11).font_semibold().text_color(t.dim).child(text.toUpperCase());

    const row = (id, title, sub, right) => h_flex().id(`row-${id}`).gap(10).items_center().px(10).py(7).rounded(8)
      .bg(t.surface).border(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(title))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.muted).child(sub))))
      .children(right);

    const installed = [...this.packs.map((p) => `piper:${p}`), ...SYSTEM.map((s) => `system:${s}`)];
    const voiceRow = (id) => {
      const inUse = current === id;
      return row(id, nice(id), id.startsWith("system:") ? "Built-in, robotic, always available" : "Voice pack", [
        button(`play-${id}`, this.playing === id ? "Playing…" : "Hear it", "play", (cx) => this.preview(id, cx)),
        inUse ? button(`use-${id}`, "In use", "check", () => {}, true) : button(`use-${id}`, "Use", null, () => this.choose(id)),
      ]);
    };
    const getRow = (v) => row(v.name, nice(`piper:${v.name}`), `${v.about} · ${v.mb} MB`, [
      this.getting[v.name]
        ? div().flex_shrink_0().text_color(t.muted).frames(["Downloading", "Downloading.", "Downloading..", "Downloading..."], 400)
        : button(`get-${v.name}`, "Download", "download", (cx) => this.download(v.name, cx)),
    ]);

    return v_flex().id("voices").size_full().p(16).gap(8).text_size(13).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(16).font_semibold().child("Voices"))
        .child(button("close", "Done", null, () => closeOverlay(props().overlay), true)))
      .child(div().text_color(t.muted).child("Pick who sounds how. Voice packs are natural voices that run on this computer."))
      .child(v_flex().id("scroll").flex_1().min_h(0).gap(6).overflow_y_scrollbar()
        .child(heading("Voice for"))
        .child(h_flex().gap(6).flex_wrap()
          .child(pill("t-default", this.target === "default", "Everyone", () => { this.target = "default"; }))
          .children(list.map((a) => pill(`t-${a.address}`, this.target === a.address, a.space_name, () => { this.target = a.address; }))))
        .when(this.target !== "default", (el) => el.child(h_flex().gap(8).items_center().text_color(t.muted)
          .child(own ? "This agent has its own voice." : "Uses the same voice as everyone.")
          .when(own, (el) => el.child(pill("same", false, "Use everyone's voice", () => this.choose(null))))))
        .child(heading("Speed"))
        .child(h_flex().gap(6).children(SPEEDS.map((s) => pill(`speed-${s}`, Math.abs(speed - s) < 0.01, `${s}×`, () => setShared("voice-agent.speed", s)))))
        .child(heading("Installed"))
        .children(installed.map(voiceRow))
        .child(heading("Get voice packs"))
        .children(SUGGESTED.filter((v) => !this.packs.includes(v.name)).map(getRow))
        .child(div().pt(6).text_size(12).text_color(t.muted).child(
          "Any Piper voice works (samples: rhasspy.github.io/piper-samples). Run "
          + "~/.local/share/herdr-voice-agent/bin/get-voice.py <name>, or put NAME.onnx and NAME.onnx.json in "
          + "~/.local/share/herdr-voice-agent/voices.")));
  }
}
