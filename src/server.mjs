// claudespeak server: the hook POSTs a recap to /say; the server speaks it with Supertonic 3 (local ONNX),
// one recap at a time for the whole machine. Each project has its own voice and a faint chime; every
// recap goes through a light compressor and a small room reverb. Settings: ~/.claudespeak/config.json.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, MODELS, LOCK, PORT, ROOT, loadConfig, saveConfig, configTime, langOf, pronounce } from "./config.mjs";
import { playerFor, systemSpeech } from "./platform.mjs";
import { createEffects, writeWav } from "./audio.mjs";
import { SpeechQueue } from "./speech.mjs";

let cfg = loadConfig(), cfgTime = configTime();
let tts = null, ttsFailed = false, ttsLoading = null;
const styles = {};
let playing = null;         // the player child
const speech = new SpeechQueue({ synthesize: synth, play, acquire, release,
  dispose: ({ file }) => fs.rmSync(file, { force: true }), onError: (e) => console.error("speech:", e.message) });

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

function engine() {
  return (ttsLoading ||= loadEngine());
}
async function loadEngine() {
  try {
    const { loadTextToSpeech, loadVoiceStyle } = await import(new URL("../vendor/supertonic/helper.js", import.meta.url));
    tts = await loadTextToSpeech(path.join(MODELS, "onnx"));
    tts.loadVoiceStyle = loadVoiceStyle;
  } catch (e) { ttsFailed = true; console.error("Supertonic failed to load (run `claudespeak install`):", e.message); }
  return tts;
}

/** Synthesises one phrase; the recap shares its voice, settings and DSP state across all phrases. */
async function synth(m) {
  const t = await engine();
  if (!t) return null;
  const { voice, settings, lang } = m;
  styles[voice] ||= t.loadVoiceStyle([path.join(MODELS, "voice_styles", `${voice}.json`)]);
  const { wav, duration } = await t.call(m.text, lang, styles[voice], settings.steps, settings.speed);
  const n = Math.floor(t.sampleRate * duration[0]);
  m.dsp.process ||= createEffects(t.sampleRate, settings.fx, settings.chimes, m.project);
  const out = m.dsp.process(Float32Array.from(wav.slice(0, n)), m);
  const file = path.join(os.tmpdir(), `claudespeak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  writeWav(file, out, t.sampleRate);
  return { file, duration: out.length / t.sampleRate };
}

// ---- One voice on the machine at a time: play.lock names the server and its player while one plays.
// Another server waits while either is alive; a player left by a killed server keeps the lock until it ends.
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function readLock() { try { return JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { return null; } }
async function acquire(signal) {
  while (!signal.aborted) {
    try { fs.writeFileSync(LOCK, JSON.stringify({ server: process.pid, at: Date.now() }), { flag: "wx" }); return true; } catch {}
    const l = readLock();
    const held = l && (alive(l.player) || (l.server !== process.pid && alive(l.server) && Date.now() - l.at < 10 * 60_000));
    if (!held) { try { fs.unlinkSync(LOCK); } catch {} continue; }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}
function release() { if (readLock()?.server === process.pid) try { fs.unlinkSync(LOCK); } catch {} }
function quit() { playing?.kill(); release(); process.kill(process.pid, "SIGKILL"); } // a plain exit trips onnxruntime's threads
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, quit);
process.on("exit", () => { playing?.kill(); release(); });

async function run([cmd, args, env = {}], signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, ...env }, windowsHide: true });
    playing = child;
    const cancel = () => child.kill();
    const done = () => { signal.removeEventListener("abort", cancel); playing = null; resolve(); };
    signal.addEventListener("abort", cancel, { once: true });
    try { fs.writeFileSync(LOCK, JSON.stringify({ server: process.pid, player: child.pid, at: Date.now() })); } catch {}
    child.once("exit", done);
    child.once("error", done);
  });
}

async function play(audio, m, signal) {
  const cmd = audio ? playerFor(audio.file) : systemSpeech(m.text);
  if (cmd) await run(cmd, signal);
  else console.error(audio ? "No audio player found (install pipewire, pulseaudio-utils, alsa-utils or ffmpeg)" : "No voice available");
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
      const voice = voiceFor(project), lang = msg.lang || langOf(cfg, project);
      if (text) speech.enqueue({ text: pronounce(cfg, text, lang), project, lang, voice,
        settings: structuredClone(cfg), dsp: {} });
      json({ queued: speech.pending, voice });
    });
    return;
  }
  if (url.pathname === "/skip") { speech.skip(); return json({ ok: true }); }
  if (url.pathname === "/stop") { speech.stop(); return json({ ok: true }); }
  if (url.pathname === "/quit") { json({ ok: true }); return setTimeout(quit, 50); }
  if (url.pathname === "/status") return json({ engine: tts ? "supertonic" : ttsFailed ? "system voice" : "loading", queued: speech.pending, playing: !!playing, pid: process.pid, root: ROOT, home: HOME });
  if (url.pathname === "/health") { res.writeHead(200).end("ok"); return; }
  res.writeHead(404).end();
}).on("error", (e) => {
  // Another copy already has the port (the login one or the hook's): leave quietly.
  if (e.code === "EADDRINUSE") process.exit(0);
  throw e;
}).listen(PORT, "127.0.0.1", () => { console.log(`claudespeak on http://127.0.0.1:${PORT}/`); engine(); });
