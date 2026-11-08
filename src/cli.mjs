// claudespeak CLI: what /speak (Claude Code) and $speak (Codex) run, plus install / uninstall / doctor.
import fs from "node:fs";
import { BASE, OFF, HOME, CONFIG, MODELS, VOICES, LANGS, MODELS_CLAUDE, DEFAULTS, loadConfig, saveConfig, projectOf, voiceOf, langOf } from "./config.mjs";
import { autostart, autostartStatus, playerName, has } from "./platform.mjs";
import { install, uninstall, modelsReady } from "./install.mjs";

const RANGE = {
  steps: [1, 20], speed: [0.7, 1.6], peak: [-12, 0], chime: [-40, -3],
  compressor: { threshold: [-40, 0], ratio: [1, 10], attack: [0.001, 0.1], release: [0.02, 1], makeup: [0, 12] },
  reverb: { room: [0, 1], damp: [0, 1], wet: [0, 1], tail: [0, 3] },
};
const ON = /^(on|true|yes|enable)$/i, OFFW = /^(off|false|no|disable)$/i;

export async function main(argv) {
  const [cmd = "toggle", ...a] = argv.map((x) => x.trim()).filter(Boolean);
  const cfg = loadConfig();
  const save = () => saveConfig(cfg);
  const project = projectOf();
  const target = (p) => (!p || p === "." ? project : p);

  switch (cmd.toLowerCase()) {
    case "install": return install(a);
    case "uninstall": return uninstall(a);
    case "doctor": return doctor(cfg);
    case "on": fs.rmSync(OFF, { force: true }); return say("Voice is ON");
    case "off": fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(OFF, ""); return say("Voice is OFF");
    case "toggle":
      if (fs.existsSync(OFF)) fs.rmSync(OFF); else { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(OFF, ""); }
      return say(fs.existsSync(OFF) ? "Voice is OFF" : "Voice is ON");
    case "status": return status(cfg, project);
    case "voices": return say(Object.entries(VOICES).map(([v, d]) => `${v}  ${d}`).join("\n"));
    case "voice": {
      const v = voice(a[0]); const p = target(a[1]);
      cfg.projects[p] = v; save(); return say(`${p} → ${v} (${VOICES[v]})`);
    }
    case "rotation":
      if (!a.length) throw new Error("give at least one voice, e.g. rotation F5 M2 M5");
      cfg.rotation = a.map(voice); save(); return say("New projects take, in turn: " + cfg.rotation.join(" → "));
    case "lang": {
      if (!a.length) return say(langLine(cfg, project));
      if (/^(reset|default)$/i.test(a[0])) { const p = target(a[1]); delete cfg.langs[p]; save(); return say(`${p} uses the global language: ${LANGS[cfg.lang]}`); }
      const code = a[0].toLowerCase();
      if (!LANGS[code]) throw new Error(`language must be one of: ${Object.keys(LANGS).join(", ")}`);
      if (a[1]) { const p = target(a[1]); cfg.langs[p] = code; save(); return say(`${p} → ${LANGS[code]}`); }
      cfg.lang = code; save(); return say(`Global language: ${LANGS[code]}`);
    }
    case "model": {
      if (!a.length) return say(`Summaries by: ${who(cfg)}`);
      const m = a[0].toLowerCase();
      if (MODELS_CLAUDE.includes(m)) cfg.claudeModel = m;
      else if (["auto", "claude", "codex", "none"].includes(m)) cfg.summarizer = m;
      else if (m === "codex-model") cfg.codexModel = a[1] || "";
      else throw new Error("model haiku|sonnet|opus (Claude), codex-model <name> (Codex), or auto|claude|codex|none (who summarises)");
      save(); return say(`Summaries by: ${who(cfg)}`);
    }
    case "steps": cfg.steps = Math.round(num(a[0], RANGE.steps, "steps")); save(); return say(`Quality: ${cfg.steps} steps`);
    case "speed": cfg.speed = num(a[0], RANGE.speed, "speed"); save(); return say(`Speed: ${cfg.speed}`);
    case "peak": cfg.fx.peak = num(a[0], RANGE.peak, "peak"); save(); return say(`Peak ceiling: ${cfg.fx.peak} dBFS`);
    case "compressor": case "reverb": {
      const f = cfg.fx[cmd];
      let i = 0;
      if (ON.test(a[0] || "")) { f.enabled = true; i = 1; } else if (OFFW.test(a[0] || "")) { f.enabled = false; i = 1; }
      for (; i < a.length; i += 2) {
        const k = a[i].toLowerCase();
        if (!RANGE[cmd][k]) throw new Error(`${cmd} settings: ${Object.keys(RANGE[cmd]).join(", ")}`);
        f[k] = num(a[i + 1], RANGE[cmd][k], `${cmd} ${k}`);
      }
      if (a.length) save();
      return say(`${cmd}: ${describe(cmd, f)}`);
    }
    case "chime": case "chimes": {
      const c = cfg.chimes, v = (a[0] || "").toLowerCase();
      if (ON.test(v)) c.enabled = true;
      else if (OFFW.test(v)) c.enabled = false;
      else if (v === "volume") { c.volume = num(a[1], RANGE.chime, "chime volume"); c.enabled = true; }
      else if (v === "reroll") { const p = target(a[1]); c.seeds[p] = (c.seeds[p] ?? 0) + 1; save(); return say(`${p} has a new chime (variant ${c.seeds[p]}); hear it with: test`); }
      else if (v) throw new Error("chime on|off|volume <dB>|reroll [project]");
      if (v) save();
      return say(chimeLine(cfg));
    }
    case "reset":
      if (a[0] === "all") Object.assign(cfg, structuredClone(DEFAULTS), { projects: cfg.projects, lang: cfg.lang, langs: cfg.langs, chimes: { ...DEFAULTS.chimes, seeds: cfg.chimes.seeds } });
      else { cfg.fx = structuredClone(DEFAULTS.fx); cfg.chimes = { ...structuredClone(DEFAULTS.chimes), seeds: cfg.chimes.seeds }; }
      save(); return say(a[0] === "all" ? "All settings back to defaults (project voices, languages and chimes kept)" : "Effects back to defaults");
    case "test": {
      const l = langOf(cfg, project);
      const text = a.join(" ") || (l === "tr" ? `Bu ${project} projesinin sesi. Ayarları duyabilmen için kısa bir deneme.`
        : `This is the voice of ${project}. A short sample, so you can hear the settings.`);
      const r = await call("/say", { text, project, lang: l === "na" ? "en" : l });
      if (!r) { (await import("./platform.mjs")).startServer(); await new Promise((res) => setTimeout(res, 1500)); }
      const r2 = r || (await call("/say", { text, project, lang: l === "na" ? "en" : l }));
      return say(r2 ? `Sample queued: ${project} (${r2.voice})` : "Couldn't reach the server; see `claudespeak doctor`.");
    }
    case "skip": await call("/skip"); return say("Skipped the recap being read");
    case "stop": await call("/stop"); return say("Queue cleared");
    case "restart": await call("/quit"); return say("Server stopped; the next recap starts it again");
    case "autostart": {
      const v = (a[0] || "status").toLowerCase();
      if (v === "status") return say(`Start at login: ${autostartStatus() ? "ON" : "OFF"}`);
      if (ON.test(v)) { await call("/quit"); await new Promise((r) => setTimeout(r, 400)); autostart(true); return say("Start at login: ON (the server runs now and after every login)"); }
      if (OFFW.test(v)) { autostart(false); return say("Start at login: OFF (the server still starts with the first recap)"); }
      throw new Error("autostart on|off|status");
    }
    case "help": case "--help": case "-h": return say(HELP);
    default: throw new Error(`unknown command: ${cmd} (try: claudespeak help)`);
  }
}

const HELP = `claudespeak — spoken summaries for Claude Code and Codex
  install [--claude] [--codex] [--autostart]   set up (downloads the voice model, ~410 MB, once)
  install --models-only                        just download the model
  uninstall [--purge]                             remove the hook, skill and autostart (--purge: models and settings too)
  status | doctor | voices | test [text] | skip | stop | restart
  on | off | toggle
  voice <F1–F5|M1–M5> [project|.]    rotation <V> <V> …
  lang <code> [project|.] | lang reset [project|.]
  model haiku|sonnet|opus | auto|claude|codex|none | codex-model <name>
  steps <1–20>   speed <0.7–1.6>   peak <dB>
  compressor [on|off] [threshold dB] [ratio N] [attack s] [release s] [makeup dB]
  reverb [on|off] [room 0–1] [damp 0–1] [wet 0–1] [tail s]
  chime [on|off] | chime volume <dB> | chime reroll [project|.]
  reset [all]   autostart on|off|status`;

function say(s) { console.log(s); }
function who(c) {
  if (c.summarizer === "none") return "nobody (the first sentence is read)";
  const cl = `Claude ${c.claudeModel}`, cx = `Codex ${c.codexModel || "(default model)"}`;
  return c.summarizer === "claude" ? cl : c.summarizer === "codex" ? cx : `the agent that finished (${cl} / ${cx})`;
}
function langLine(c, p) {
  const own = Object.entries(c.langs);
  return `Language: ${LANGS[c.lang]} (${c.lang}); this project: ${LANGS[langOf(c, p)]}` + (own.length ? `; per project: ${own.map(([k, v]) => `${k} ${v}`).join(", ")}` : "");
}
function chimeLine(c) { return c.chimes.enabled ? `Chimes: on, ${-c.chimes.volume} dB under the voice; each project has its own` : "Chimes: off"; }
function describe(name, f) {
  if (f.enabled === false) return "off";
  return name === "compressor"
    ? `on, ${f.ratio}:1 over ${f.threshold} dB, attack ${f.attack * 1000} ms, release ${f.release * 1000} ms, +${f.makeup} dB`
    : `on, room ${f.room}, damp ${f.damp}, wet ${f.wet}, tail ${f.tail} s`;
}
async function status(c, p) {
  const s = await call("/status");
  say([
    `Voice ${fs.existsSync(OFF) ? "OFF" : "ON"} · server ${s ? `running (${s.engine}, ${s.queued} queued)` : "not running (starts with the first recap)"} · start at login ${autostartStatus() ? "on" : "off"}`,
    `This project: ${p} → ${c.projects[p] || `${voiceOf(c, p)} (assigned with its first recap)`}`,
    `Projects: ${Object.entries(c.projects).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}`,
    `New projects take: ${c.rotation.join(" → ")}`,
    langLine(c, p),
    `Summaries by: ${who(c)}`,
    `Quality ${c.steps} steps · speed ${c.speed} · peak ${c.fx.peak} dBFS`,
    chimeLine(c),
    `Compressor: ${describe("compressor", c.fx.compressor)}`,
    `Reverb: ${describe("reverb", c.fx.reverb)}`,
  ].join("\n"));
}
async function doctor(c) {
  const s = await call("/status");
  const ok = (b) => (b ? "ok " : "-- ");
  say([
    `${ok(true)}node ${process.version} (${process.platform} ${process.arch})`,
    `${ok(modelsReady())}voice model in ${MODELS}`,
    `${ok(fs.existsSync(CONFIG))}config ${CONFIG}`,
    `${ok(playerName() !== "none")}audio player: ${playerName()}`,
    `${ok(has("claude"))}claude CLI${has("claude") ? "" : " (needed for Claude summaries)"}`,
    `${ok(has("codex"))}codex CLI${has("codex") ? "" : " (needed for Codex summaries)"}`,
    `${ok(!!s)}server ${s ? `pid ${s.pid}, ${s.engine}` : "not running"}`,
    `${ok(!fs.existsSync(OFF))}voice ${fs.existsSync(OFF) ? "off (claudespeak on)" : "on"}`,
    `${ok(autostartStatus())}start at login`,
  ].join("\n"));
}
function voice(v) {
  const u = String(v || "").toUpperCase();
  if (!VOICES[u]) throw new Error(`voice must be one of ${Object.keys(VOICES).join(", ")}`);
  return u;
}
function num(v, [lo, hi], what) {
  const x = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
  return x;
}
async function call(p, body) {
  try {
    const r = await fetch(BASE + p, body ? { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(1500) } : { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch { return null; }
}
