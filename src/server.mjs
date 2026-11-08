// claudespeak server: the hook POSTs a recap to /say; the server speaks it with Supertonic 3 (local ONNX),
// one recap at a time for the whole machine. Each project has its own voice and a faint chime; every
// recap goes through a light compressor and a small room reverb. Settings: ~/.claudespeak/config.json.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, MODELS, LOCK, PORT, ROOT, loadConfig, saveConfig, configTime, langOf } from "./config.mjs";
import { playerFor, systemSpeech } from "./platform.mjs";

const STALE = 3 * 60_000;   // a recap that waited longer than this is dropped
const GAP_MS = 350;         // breath between two recaps

let cfg = loadConfig(), cfgTime = configTime();
let tts = null, ttsFailed = false;
const styles = {};
const queue = [];           // { text, project, lang, at, audio?: Promise<wavPath|null> }
let playing = null;         // the player child
let busy = false;

/** The config is re-read when the file changes, so edits apply without a restart. */
function freshCfg() { const t = configTime(); if (t !== cfgTime) { cfg = loadConfig(); cfgTime = t; } }

/** The project's voice; a new project takes the rotation's next one. */
function voiceFor(project) {
  if (!cfg.projects[project]) {
    cfg.projects[project] = cfg.rotation[Object.keys(cfg.projects).length % cfg.rotation.length];
    try { saveConfig(cfg); cfgTime = configTime(); } catch {}
  }
  return cfg.projects[project];
}

async function engine() {
  if (tts || ttsFailed) return tts;
  try {
    const { loadTextToSpeech, loadVoiceStyle } = await import(new URL("../vendor/supertonic/helper.js", import.meta.url));
    tts = await loadTextToSpeech(path.join(MODELS, "onnx"));
    tts.loadVoiceStyle = loadVoiceStyle;
  } catch (e) { ttsFailed = true; console.error("Supertonic failed to load (run `claudespeak install`):", e.message); }
  return tts;
}

/** Synthesises a recap (with chimes and effects) to a temporary WAV; null if the engine isn't there. */
async function synth(m) {
  const t = await engine();
  if (!t) return null;
  const voice = voiceFor(m.project);
  styles[voice] ||= t.loadVoiceStyle([path.join(MODELS, "voice_styles", `${voice}.json`)]);
  const { wav, duration } = await t.call(m.text, m.lang || langOf(cfg, m.project), styles[voice], cfg.steps, cfg.speed);
  const n = Math.floor(t.sampleRate * duration[0]);
  const out = effects(Float32Array.from(wav.slice(0, n)), t.sampleRate, cfg.fx, cfg.chimes.enabled ? m.project : null);
  const file = path.join(os.tmpdir(), `claudespeak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  writeWav(file, out, t.sampleRate);
  return file;
}

// ---- Effects: light compressor → the project's chimes around the voice → small room reverb → peak ceiling.
function effects(x, sr, fx, chimeKey) {
  if (fx.compressor?.enabled !== false) x = compress(x, sr, fx.compressor);
  if (chimeKey) x = withChimes(x, sr, chimeKey);
  if (fx.reverb?.enabled !== false) x = reverb(x, sr, fx.reverb);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const ceil = 10 ** ((fx.peak ?? -1) / 20);
  if (peak > ceil) for (let i = 0; i < x.length; i++) x[i] *= ceil / peak;
  return x;
}

/** Feed-forward peak compressor with a smoothed envelope; gentle by default (2:1 over −20 dB). */
function compress(x, sr, { threshold, ratio, attack, release, makeup }) {
  const a = Math.exp(-1 / (attack * sr)), r = Math.exp(-1 / (release * sr));
  const make = 10 ** (makeup / 20), out = new Float32Array(x.length);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    env = v > env ? a * env + (1 - a) * v : r * env + (1 - r) * v;
    const over = 20 * Math.log10(env + 1e-9) - threshold;
    out[i] = x[i] * (over > 0 ? 10 ** ((-over * (1 - 1 / ratio)) / 20) : 1) * make;
  }
  return out;
}

/** Mono Freeverb (8 damped combs → 4 allpasses) under the dry voice, with a tail to ring out. */
function reverb(x, sr, { room, damp, wet, tail }) {
  const k = sr / 44100, n = x.length + Math.floor(tail * sr);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((l) => ({ buf: new Float32Array(Math.round(l * k)), i: 0, store: 0 }));
  const alls = [556, 441, 341, 225].map((l) => ({ buf: new Float32Array(Math.round(l * k)), i: 0 }));
  const fb = room * 0.28 + 0.7, d = damp * 0.4, out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const dry = t < x.length ? x[t] : 0, inp = dry * 0.015;
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.store = y * (1 - d) + c.store * d;
      c.buf[c.i] = inp + c.store * fb;
      if (++c.i >= c.buf.length) c.i = 0;
      acc += y;
    }
    for (const ap of alls) {
      const b = ap.buf[ap.i];
      ap.buf[ap.i] = acc + b * 0.5;
      if (++ap.i >= ap.buf.length) ap.i = 0;
      acc = b - acc;
    }
    out[t] = dry + acc * wet * 3;
  }
  return out;
}

// ---- Chimes: a faint two-note signature per project, from its name (and its reroll seed).
const TIMBRES = {
  sine: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.08 * Math.sin(4 * Math.PI * f * t),
  bell: (f, t) => Math.sin(2 * Math.PI * f * t + 1.1 * Math.exp(-t / 0.07) * Math.sin(2 * Math.PI * 3.5 * f * t)),
  glass: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.3 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 2.76 * f * t),
  marimba: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.3 * Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * 4 * f * t),
  pluck: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.35 * Math.exp(-t / 0.02) * Math.sin(2 * Math.PI * 3 * f * t),
};
const PENTA = [0, 2, 4, 7, 9], INTERVALS = [4, 5, 7, 9];
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Timbre, root (C5–D6 pentatonic, top note under ~2 kHz), interval, spacing and decay. */
function chimeSpec(key) {
  const r = rng(hash(key + ":" + (cfg.chimes.seeds[key] ?? 0)));
  const names = Object.keys(TIMBRES), step = Math.floor(r() * 7);
  return {
    timbre: names[Math.floor(r() * names.length)],
    root: 523.25 * 2 ** ((12 * Math.floor(step / 5) + PENTA[step % 5]) / 12),
    ratio: 2 ** (INTERVALS[Math.floor(r() * INTERVALS.length)] / 12),
    gap: 0.06 + r() * 0.04, tau: 0.07 + r() * 0.05,
  };
}
function chime(sr, spec, notes, gap, tau) {
  const len = Math.ceil((gap * (notes.length - 1) + tau * 6) * sr), out = new Float32Array(len), wave = TIMBRES[spec.timbre];
  notes.forEach((f, k) => {
    const at = Math.floor(k * gap * sr), g = k ? 0.8 : 1;
    for (let i = 0; at + i < len; i++) {
      const t = i / sr, env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
      if (env < 1e-4 && t > 0.01) break;
      out[at + i] += g * env * wave(f, t);
    }
  });
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < len; i++) out[i] /= peak || 1;
  return out;
}
/** A rising chime, the voice coming in as it fades, and a falling chime after the last word. */
function withChimes(x, sr, key) {
  const s = chimeSpec(key), top = s.root * s.ratio;
  const intro = chime(sr, s, [s.root, top], s.gap, s.tau);
  const outro = chime(sr, s, [top, s.root * 0.75], s.gap * 1.3, s.tau * 1.4);
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = (peak || 0.3) * 10 ** (cfg.chimes.volume / 20);
  const vAt = Math.floor((s.gap + 2.2 * s.tau) * sr), oAt = vAt + x.length + Math.floor(0.1 * sr);
  const out = new Float32Array(Math.max(vAt + x.length, oAt + outro.length));
  for (let i = 0; i < intro.length; i++) out[i] += intro[i] * g;
  for (let i = 0; i < x.length; i++) out[vAt + i] += x[i];
  for (let i = 0; i < outro.length; i++) out[oAt + i] += outro[i] * g;
  return out;
}

function writeWav(file, s, rate) {
  const n = s.length, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i] || 0)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// ---- One voice on the machine at a time: play.lock names the server and its player while one plays.
// Another server waits while either is alive; a player left by a killed server keeps the lock until it ends.
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function readLock() { try { return JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { return null; } }
async function acquire() {
  for (;;) {
    try { fs.writeFileSync(LOCK, JSON.stringify({ server: process.pid, at: Date.now() }), { flag: "wx" }); return; } catch {}
    const l = readLock();
    const held = l && (alive(l.player) || (l.server !== process.pid && alive(l.server) && Date.now() - l.at < 10 * 60_000));
    if (!held) { try { fs.unlinkSync(LOCK); } catch {} continue; }
    await new Promise((r) => setTimeout(r, 120));
  }
}
function release() { if (readLock()?.server === process.pid) try { fs.unlinkSync(LOCK); } catch {} }
function quit() { playing?.kill(); release(); process.kill(process.pid, "SIGKILL"); } // a plain exit trips onnxruntime's threads
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, quit);
process.on("exit", () => { playing?.kill(); release(); });

async function run([cmd, args, env = {}]) {
  await acquire();
  await new Promise((resolve) => {
    playing = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, ...env }, windowsHide: true });
    try { fs.writeFileSync(LOCK, JSON.stringify({ server: process.pid, player: playing.pid, at: Date.now() })); } catch {}
    playing.on("exit", () => { playing = null; resolve(); });
    playing.on("error", () => { playing = null; resolve(); });
  });
  release();
}

/** Plays the queue out, synthesising the next recap while the current one plays. */
async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      if (Date.now() - m.at > STALE) { m.audio?.then((f) => f && fs.rm(f, () => {})); continue; }
      m.audio ||= synth(m).catch((e) => (console.error("synth:", e.message), null));
      const file = await m.audio;
      if (queue[0]) queue[0].audio ||= synth(queue[0]).catch(() => null);
      const cmd = file ? playerFor(file) : systemSpeech(m.text);
      if (cmd) await run(cmd);
      else console.error(file ? "No audio player found (install pipewire, pulseaudio-utils, alsa-utils or ffmpeg)" : "No voice available");
      if (file) fs.rm(file, () => {});
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally { busy = false; }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (o) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  if (req.method === "POST" && url.pathname === "/say") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      freshCfg();
      const text = String(msg.text || "").trim(), project = String(msg.project || "default");
      if (text) { queue.push({ text, project, lang: msg.lang, at: Date.now() }); pump(); }
      json({ queued: queue.length, voice: voiceFor(project) });
    });
    return;
  }
  if (url.pathname === "/skip") { playing?.kill(); return json({ ok: true }); }
  if (url.pathname === "/stop") { queue.length = 0; playing?.kill(); return json({ ok: true }); }
  if (url.pathname === "/quit") { json({ ok: true }); return setTimeout(quit, 50); }
  if (url.pathname === "/status") return json({ engine: tts ? "supertonic" : ttsFailed ? "system voice" : "loading", queued: queue.length, playing: !!playing, pid: process.pid, root: ROOT, home: HOME });
  if (url.pathname === "/health") { res.writeHead(200).end("ok"); return; }
  res.writeHead(404).end();
}).on("error", (e) => {
  // Another copy already has the port (the login one or the hook's): leave quietly.
  if (e.code === "EADDRINUSE") process.exit(0);
  throw e;
}).listen(PORT, "127.0.0.1", () => { console.log(`claudespeak on http://127.0.0.1:${PORT}/`); engine(); });
