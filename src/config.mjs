// Shared paths, defaults and the config file (~/.claudespeak/config.json), used by the server,
// the hook and the CLI. The server re-reads the file when it changes, so edits apply at once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = process.env.CLAUDESPEAK_HOME || path.join(os.homedir(), ".claudespeak");
export const CONFIG = path.join(HOME, "config.json");
export const MODELS = path.join(HOME, "models");
export const OFF = path.join(HOME, "off");
export const LOG = path.join(HOME, "server.log");
export const LOCK = path.join(HOME, "play.lock");
export const PORT = Number(process.env.CLAUDESPEAK_PORT || 7841);
export const BASE = `http://127.0.0.1:${PORT}`;

export const VOICES = {
  F1: "calm, slightly low female", F2: "bright, cheerful, youthful female", F3: "clear, professional announcer female",
  F4: "crisp, confident female", F5: "kind, gentle, soothing female",
  M1: "lively, upbeat male", M2: "deep, calm, serious male", M3: "polished, authoritative male",
  M4: "soft, friendly, youthful male", M5: "warm, soft-spoken storyteller male",
};
// Supertonic 3's languages; "na" = whatever language the message is in.
export const LANGS = {
  en: "English", tr: "Turkish", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", ru: "Russian", uk: "Ukrainian", pl: "Polish", cs: "Czech", sk: "Slovak", sl: "Slovenian",
  hr: "Croatian", bg: "Bulgarian", ro: "Romanian", hu: "Hungarian", el: "Greek", fi: "Finnish", et: "Estonian",
  lv: "Latvian", lt: "Lithuanian", sv: "Swedish", da: "Danish", ar: "Arabic", hi: "Hindi", id: "Indonesian",
  vi: "Vietnamese", ja: "Japanese", ko: "Korean", na: "the message's own language",
};
export const MODELS_CLAUDE = ["haiku", "sonnet", "opus"];

/** The OS's display language (not its region format) if Supertonic speaks it, else English. */
export function systemLang() {
  const run = (cmd, args) => {
    try { const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 5000 }); return r.status === 0 ? r.stdout : ""; } catch { return ""; }
  };
  let tag = "";
  if (process.platform === "darwin") tag = (run("defaults", ["read", "-g", "AppleLanguages"]).match(/[A-Za-z]{2,3}(?=[-_",\s)])/) || [""])[0];
  else if (process.platform === "win32") tag = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-UICulture).Name"]).trim();
  else tag = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, process.env.LANGUAGE].find((v) => v && !/^(C|POSIX)([._]|$)/.test(v)) || "";
  tag ||= Intl.DateTimeFormat().resolvedOptions().locale || "en";
  const l = tag.slice(0, 2).toLowerCase();
  return LANGS[l] && l !== "na" ? l : "en";
}

export const DEFAULTS = {
  lang: "",                         // "" = the OS's display language (systemLang), fixed into the config when first saved
  langs: {},                        // per-project language
  rotation: ["F5", "M2", "M5"],     // voices new projects take in turn
  projects: {},                     // project → voice
  summarizer: "auto",               // auto (the agent that finished) | claude | codex | none (first sentence)
  claudeModel: "sonnet",
  codexModel: "",                   // "" = Codex's own default
  steps: 6,                         // Supertonic denoising steps (quality)
  speed: 1.05,
  chimes: { enabled: true, volume: -14, seeds: {} },
  lexicon: {},                      // per language: term → how to say it, e.g. { tr: { GraphQL: "graf kyu el" } }
  fx: {
    compressor: { enabled: true, threshold: -20, ratio: 2, attack: 0.01, release: 0.15, makeup: 2 },
    reverb: { enabled: true, room: 0.45, damp: 0.5, wet: 0.22, tail: 0.7 },
    peak: -1,
  },
};

export function loadConfig() {
  const d = structuredClone(DEFAULTS);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch {}
  const out = {
    ...d, ...c,
    langs: { ...c.langs }, projects: { ...c.projects }, lexicon: { ...c.lexicon },
    chimes: { ...d.chimes, ...c.chimes, seeds: { ...c.chimes?.seeds } },
    fx: {
      ...d.fx, ...c.fx,
      compressor: { ...d.fx.compressor, ...c.fx?.compressor },
      reverb: { ...d.fx.reverb, ...c.fx?.reverb },
    },
  };
  if (!LANGS[out.lang]) out.lang = systemLang();
  return out;
}
export function saveConfig(c) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
}
export function configTime() { try { return fs.statSync(CONFIG).mtimeMs; } catch { return 0; } }

/** A project is its git root's folder name (else the folder's own). */
export function projectOf(cwd = process.cwd()) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  return path.basename(r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd) || "default";
}
/** The voice a project has, or the one it will get. */
export function voiceOf(c, project) {
  return c.projects[project] || c.rotation[Object.keys(c.projects).length % c.rotation.length];
}
export function langOf(c, project) { return c.langs[project] || c.lang; }

/** Whole-word, case-insensitive replacements from the lexicon of a language, longest terms first. */
export function pronounce(c, text, lang) {
  const lex = c.lexicon?.[lang];
  if (!lex) return text;
  for (const [term, say] of Object.entries(lex).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    text = text.replace(re, say);
  }
  return text;
}
