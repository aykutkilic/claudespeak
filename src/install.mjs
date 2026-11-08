// Setup: downloads Supertonic 3 (OpenRAIL-M; fetched from Hugging Face, not shipped here), then wires the
// hook and the /speak skill into Claude Code and/or Codex. Existing settings are merged, with a backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, MODELS, CONFIG, ROOT, BASE, loadConfig, saveConfig } from "./config.mjs";
import { autostart, autostartStatus } from "./platform.mjs";

const REPO = "https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46";
const FILES = {
  "onnx/duration_predictor.onnx": 3700147, "onnx/text_encoder.onnx": 36416150, "onnx/vector_estimator.onnx": 256534781,
  "onnx/vocoder.onnx": 101424195, "onnx/tts.json": 0, "onnx/unicode_indexer.json": 0, "LICENSE": 0,
  ...Object.fromEntries(["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((v) => [`voice_styles/${v}.json`, 0])),
};
const MARK = "--claudespeak";   // tags our hook / notify entries so they can be found again
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const AGENTS_SKILLS = path.join(os.homedir(), ".agents", "skills");
const q = (p) => (/[\s"]/.test(p) ? `"${p}"` : p);
const HOOK = path.join(ROOT, "src", "hook.mjs");
const CLI = `${q(process.execPath)} ${q(path.join(ROOT, "bin", "claudespeak.mjs"))}`;

export function modelsReady() {
  return Object.entries(FILES).every(([f, size]) => {
    try { const s = fs.statSync(path.join(MODELS, f)); return size ? s.size === size : s.size > 0; } catch { return false; }
  });
}

async function download() {
  for (const [f, size] of Object.entries(FILES)) {
    const dest = path.join(MODELS, f);
    try { const s = fs.statSync(dest); if (size ? s.size === size : s.size > 0) continue; } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(`${REPO}/${f}`);
    if (!r.ok) throw new Error(`download ${f}: HTTP ${r.status}`);
    const total = Number(r.headers.get("content-length")) || size, part = dest + ".part", out = fs.createWriteStream(part);
    let got = 0, shown = -1;
    for await (const chunk of r.body) {
      out.write(chunk); got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (total > 5e6 && pct !== shown && pct % 5 === 0) { process.stderr.write(`\r  ${f} ${pct}%   `); shown = pct; }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (size && fs.statSync(part).size !== size) throw new Error(`download ${f}: size mismatch, try again`);
    fs.renameSync(part, dest);
    if (total > 5e6) process.stderr.write(`\r  ${f} done        \n`);
  }
}

function backup(file) { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".claudespeak-backup"); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (fs.existsSync(file)) throw new Error(`${file} isn't valid JSON: ${e.message}`); return {}; } }

/** Our Stop hook in Claude Code's settings.json (replacing an older one of ours). */
function claudeHook(on) {
  const file = path.join(CLAUDE_DIR, "settings.json"), s = readJson(file);
  const groups = (s.hooks?.Stop || []).filter((g) => !g.hooks?.some((h) => String(h.command || "").includes(MARK)));
  if (on) groups.push({ hooks: [{ type: "command", command: `${q(process.execPath)} ${q(HOOK)} --agent claude ${MARK}`, timeout: 60, async: true }] });
  s.hooks = { ...s.hooks, Stop: groups };
  if (!groups.length) delete s.hooks.Stop;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  backup(file);
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
}

/** Codex's top-level `notify` in config.toml: ours, with a notify that was there before chained. */
function codexNotify(on) {
  const file = path.join(CODEX_DIR, "config.toml");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  const tableAt = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = tableAt < 0 ? lines.length : tableAt;
  let at = lines.slice(0, top).findIndex((l) => /^\s*notify\s*=/.test(l)), end = at;
  let old = null, ours = false;
  if (at >= 0) {
    let depth = 0, val = "";
    for (end = at; end < lines.length; end++) {
      const l = end === at ? lines[end].replace(/^\s*notify\s*=/, "") : lines[end];
      val += l + "\n";
      depth += (l.match(/\[/g) || []).length - (l.match(/]/g) || []).length;
      if (depth <= 0) break;
    }
    ours = val.includes(MARK);
    if (!ours) {
      try { old = JSON.parse(val.replace(/#.*$/gm, "").replace(/'([^']*)'/g, (_, s) => JSON.stringify(s)).replace(/,\s*]/, "]")); } catch { old = null; }
    }
  }
  const cfg = loadConfig();
  if (on && old) { cfg.codexNotifyChain = old; saveConfig(cfg); }
  const line = `notify = ${JSON.stringify([process.execPath, HOOK, "--agent", "codex", MARK])}`;
  const restore = !on && Array.isArray(cfg.codexNotifyChain) ? `notify = ${JSON.stringify(cfg.codexNotifyChain)}` : null;
  if (!on && !ours) return;   // someone else's notify: leave it alone
  if (at >= 0) lines.splice(at, end - at + 1, ...(on ? [line] : restore ? [restore] : []));
  else if (on) lines.splice(0, 0, line);
  if (!on && cfg.codexNotifyChain) { delete cfg.codexNotifyChain; saveConfig(cfg); }
  backup(file);
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
}

/** The /speak skill (Claude Code) or $speak skill (Codex), pointing at this checkout's CLI. */
function skill(dir, flavour, on) {
  const file = path.join(dir, "speak", "SKILL.md");
  if (!on) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("claudespeak")) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return;
  }
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("claudespeak")) backup(file);
  const body = fs.readFileSync(path.join(ROOT, "skill", "SKILL.md"), "utf8").replaceAll("{{CLI}}", CLI);
  const head = flavour === "claude"
    ? `---\nname: speak\ndescription: claudespeak — spoken summaries when a turn ends. On/off, voices, language, summary model, quality, speed, chimes, compressor, reverb, autostart, test. Usage: /speak [status|voice F5|lang en|reverb wet 0.3|test|…] or plain words ("make the reverb a bit lighter").\nargument-hint: "[on|off|status|voices|voice V|lang code|model …|chime …|reverb …|test|autostart on|off]"\ndisable-model-invocation: true\nallowed-tools: Bash(${CLI}:*)\n---\n\nThe user's request: $ARGUMENTS\n\n`
    : `---\nname: speak\ndescription: claudespeak — configure the spoken summaries read when a Codex turn ends (on/off, voices, language, summary model, quality, speed, chimes, compressor, reverb, autostart, test). Use only when the user invokes $speak.\n---\n\nThe user's request is what follows $speak in their message.\n\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, head + body);
}

export async function install(args) {
  const want = (k) => args.includes(`--${k}`);
  if (want("models-only")) { await download(); return console.log(`Voice model ready in ${MODELS}`); }
  const claude = want("claude") || (!want("codex") && fs.existsSync(CLAUDE_DIR));
  const codex = want("codex") || (!want("claude") && fs.existsSync(CODEX_DIR));
  if (!claude && !codex) throw new Error("found neither Claude Code (~/.claude) nor Codex (~/.codex); pass --claude or --codex");
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(CONFIG)) saveConfig(loadConfig());   // the language starts as the OS's (else English)
  if (!want("no-models")) {
    if (!modelsReady()) console.log("Downloading Supertonic 3 (about 410 MB, once)…");
    await download();
  }
  if (claude) { claudeHook(true); skill(path.join(CLAUDE_DIR, "skills"), "claude", true); }
  if (codex) { codexNotify(true); skill(AGENTS_SKILLS, "codex", true); }
  if (want("autostart")) autostart(true);
  // A server from an older checkout would keep its code: stop it, the next recap starts this one.
  try { await fetch(BASE + "/quit", { signal: AbortSignal.timeout(1000) }); } catch {}
  console.log([
    "claudespeak is set up:",
    claude && `  Claude Code: Stop hook + /speak (restart open sessions to pick them up)`,
    codex && `  Codex: notify + $speak skill (restart Codex)`,
    `  Settings: ${CONFIG}  ·  language ${loadConfig().lang}`,
    `  Start at login: ${autostartStatus() ? "on" : "off (claudespeak autostart on)"}`,
    "Try it: claudespeak test",
  ].filter(Boolean).join("\n"));
}

export async function uninstall(args) {
  if (fs.existsSync(path.join(CLAUDE_DIR, "settings.json"))) claudeHook(false);
  skill(path.join(CLAUDE_DIR, "skills"), "claude", false);
  if (fs.existsSync(path.join(CODEX_DIR, "config.toml"))) codexNotify(false);
  skill(AGENTS_SKILLS, "codex", false);
  try { if (autostartStatus()) autostart(false); } catch {}
  try { await fetch(BASE + "/quit", { signal: AbortSignal.timeout(1000) }); } catch {}
  if (args.includes("--purge")) fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`claudespeak removed${args.includes("--purge") ? " (models and settings too)" : `; models and settings stay in ${HOME} (--purge removes them)`}.`);
}
