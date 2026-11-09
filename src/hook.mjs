// claudespeak hook: runs when an agent's turn ends and hands a spoken summary to the server.
//   Claude Code: a Stop hook, `node hook.mjs --agent claude` (the event JSON on stdin).
//   Codex:       notify = ["node", "hook.mjs", "--agent", "codex"] (the event JSON appended as the last argument).
//   Copilot CLI: an agentStop hook, `node hook.mjs --agent copilot --detach` (the event JSON on stdin; the
//                message is read from the session's events.jsonl).
//   opencode:    its plugin (opencode-plugin.js) pipes { cwd, last_assistant_message } to `--agent opencode`.
// The summary (one or two sentences, in the project's language) is written by the same agent's CLI
// (claude -p / codex exec / copilot -p / opencode run) unless config says otherwise; without one, the
// message's first sentence is read.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BASE, OFF, LANGS, MODELS_CLAUDE, AGENTS, COPILOT_DIR, loadConfig, projectOf, langOf } from "./config.mjs";
import { runCli, startServer } from "./platform.mjs";
import { lastMessage, copilotMessage, recap, sayable } from "./text.mjs";

const INPUT_CHARS = 8000;   // of the message, for the summariser
const ARG_CHARS = 3000;     // copilot takes the prompt as an argument, and cmd.exe allows about 8000 characters

// How a few foreign terms are written for each voice, to show the model the idea (it applies it to every term).
const SOUND_EXAMPLES = {
  tr: "macOS → mekos, MIT → emayti, GitHub → githab, Windows → vindovs, Linux → linuks, Claude → klod, " +
    "JSON → ceyson, API → eypiay, npm → enpiem, CI → siay, commit → komit, push → puş, hook → huk, server → sörvır, " +
    "Docker → dokır, Three.js → tri ceyes, Vite → vayt, Vercel → vörsıl, React → riyekt, Python → paytın",
  de: "GitHub → Gitt-Hab, Windows → Windous, Claude → Klohd, JSON → Dschäisen, API → Äi-Pi-Ai, push → pusch",
  es: "GitHub → guit-jab, Windows → uíndous, Claude → clod, JSON → yéison, API → ei-pi-ai, push → push",
  fr: "GitHub → guite-heub, Windows → ouinndoze, Claude → klôde, JSON → djéïsonne, API → éi-pi-aï",
  it: "GitHub → ghit-hab, Windows → uìndous, Claude → clod, JSON → géison, API → ei-pi-ai",
};

/** The event JSON: Codex's last argument, the detached parent's copy, or stdin. */
function rawEvent() {
  try { return argv.findLast((a) => a.trim().startsWith("{")) ?? process.env.CLAUDESPEAK_EVENT ?? fs.readFileSync(0, "utf8"); } catch { return ""; }
}

/** { text, cwd } from the agent's event; null when there's nothing to say. */
function readEvent(raw) {
  let d;
  try { d = JSON.parse(raw || "{}"); } catch { return null; }
  if (agent === "codex" && d.type && d.type !== "agent-turn-complete") return null;
  let text = String(d["last-assistant-message"] ?? d.last_assistant_message ?? "").trim();
  if (!text && agent === "copilot") {
    const id = d.sessionId ?? d.session_id;
    text = copilotMessage(d.transcriptPath || d.transcript_path || (id && path.join(COPILOT_DIR, "session-state", String(id), "events.jsonl")));
  } else if (!text) text = lastMessage(d.transcript_path);
  text = text.trim();
  return text ? { text, cwd: d.cwd || process.cwd() } : null;
}

/** Copilot CLI waits for its hooks: hand the event to a detached copy of this hook and return at once. */
function detach(raw) {
  const args = argv.filter((a) => a !== "--detach");
  spawn(process.execPath, [process.argv[1], ...args], {
    detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, CLAUDESPEAK_EVENT: raw },
  }).unref();
}

/** The text `opencode run --format json` printed, and the sessions it made (deleted afterwards). */
function opencodeOutput(jsonl) {
  const events = jsonl.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return {
    text: events.filter((e) => e.type === "text").map((e) => e.part?.text || "").join("\n").trim(),
    sessions: [...new Set(events.map((e) => e.sessionID).filter(Boolean))],
  };
}

// Letters (or letter groups) a word of this language never has: one in the output means a word wasn't respelled.
// English letter names as a voice of this language should say them (for acronyms).
const LETTERS = {
  tr: "A ey, B bi, C si, D di, E i, F ef, G ci, H eyç, I ay, J cey, K key, L el, M em, N en, O ou, P pi, Q kyu, " +
    "R ar, S es, T ti, U yu, V vi, W dabılyu, X eks, Y vay, Z zi (so WebGPU → veb ci pi yu, ESLint → i es lint)",
};
const FOREIGN_MARKS = { tr: "w, x, q, th, sh, ch, ph, ee, oo, ea, ou, ck, a final silent e, or a .js/.ts ending" };

function prompt() {
  const language = lang === "na" ? "the language the message is written in" : LANGS[lang];
  const base = "You are a voice assistant. You get the end-of-turn message of an AI coding assistant. Sum up what was " +
    `done or what the outcome is in at most two short spoken sentences, in ${language}. If the message asks a question ` +
    "or waits for the user, say so. Write numbers as words. No file paths, code, commands, URLs, markdown, quotes or " +
    "emoji; say technical names plainly.";
  if (lang === "en" || lang === "na") return base + " Write only the summary.";
  return base +
    ` The summary is read by a ${language} text-to-speech voice that says every word by ${language} spelling rules, ` +
    `so every word that isn't ${language} (product names, English technical terms, acronyms, people's names, ` +
    `capitalised or not) must be respelled the way it is pronounced, with ${language} letters. Acronyms are said ` +
    "letter by letter, with the English letter names, written as one word or with spaces." +
    (LETTERS[lang] ? ` English letter names in ${language} spelling: ${LETTERS[lang]}.` : "") +
    (SOUND_EXAMPLES[lang] ? ` Examples: ${SOUND_EXAMPLES[lang]}.` : "") +
    (FOREIGN_MARKS[lang] ? ` A word with ${FOREIGN_MARKS[lang]} is never ${language}: respell it.` : "") +
    (Object.keys(cfg.lexicon?.[lang] || {}).length ? ` Always use these respellings: ${Object.entries(cfg.lexicon[lang]).map(([k, v]) => `${k} → ${v}`).join(", ")}.` : "") +
    "\nAnswer in exactly two lines and nothing else:\n" +
    `TERMS: every non-${language} word of your summary with its respelling, as "original = respelled; …" (or "none")\n` +
    `SAY: the summary itself, in ${language}, using only the respellings`;
}

/** One or two sentences from the agent's own CLI; "" if it isn't there or fails. */
async function summarize(text) {
  const who = cfg.summarizer === "auto" ? agent : cfg.summarizer;
  const msg = text.slice(0, INPUT_CHARS), env = { CLAUDESPEAK_CHILD: "1" };
  let out = "";
  if (who === "claude") {
    const model = MODELS_CLAUDE.includes(cfg.claudeModel) ? cfg.claudeModel : "sonnet";
    const base = ["-p", "--no-session-persistence", "--model", model, "--tools", "", "--system-prompt", prompt()];
    out = await runCli("claude", ["--safe-mode", ...base], "Message:\n" + msg, { env });
    if (!out) out = await runCli("claude", base, "Message:\n" + msg, { env });  // an older CLI without --safe-mode
  } else if (who === "codex") {
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", ...(cfg.codexModel ? ["-m", cfg.codexModel] : []), "-"];
    out = await runCli("codex", args, prompt() + "\n\nMessage:\n" + msg, { env, timeout: 45_000 });
  } else if (who === "copilot") {
    // -p runs without asking: tools that need approval are refused, and shell and file writes are denied outright.
    const args = ["-p", prompt() + "\n\nMessage:\n" + msg.slice(0, ARG_CHARS), "-s", "--no-ask-user",
      "--deny-tool=shell", "--deny-tool=write", ...(cfg.copilotModel ? ["--model", cfg.copilotModel] : [])];
    out = await runCli("copilot", args, "", { env, timeout: 45_000 });
  } else if (who === "opencode") {
    // opencode 2.x has a `summary` agent with every tool denied; 1.x's closest is the read-only `plan`.
    const v2 = Number((await runCli("opencode", ["--version"], "", { env, timeout: 10_000 })).match(/(\d+)\./)?.[1]) >= 2;
    const args = ["run", "--format", "json", "--agent", v2 ? "summary" : "plan", "--title", "claudespeak-summary",
      ...(cfg.opencodeModel ? ["-m", cfg.opencodeModel] : [])];
    const r = opencodeOutput(await runCli("opencode", args, prompt() + "\n\nMessage:\n" + msg, { env, timeout: 45_000 }));
    out = r.text;
    // A run that timed out never said its session: those are found by their title.
    if (!r.sessions.length) r.sessions = (await runCli("opencode", ["session", "list"], "", { env, timeout: 10_000 }))
      .split("\n").map((l) => l.split("\t")).filter((c) => c[1] === "claudespeak-summary").map((c) => c[0]);
    for (const id of r.sessions) await runCli("opencode", ["session", "delete", id], "", { env, timeout: 10_000 });
  }
  // A two-line answer (TERMS / SAY): only the SAY line is read.
  const say = out.match(/SAY:\s*([\s\S]*)$/i);
  if (say) out = say[1];
  else out = out.replace(/^\s*TERMS:.*$/gim, "");
  return out.replace(/[*_#`>|[\]{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
}

async function post(body) {
  const r = await fetch(`${BASE}/say`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
  return r.ok;
}

/** Hand the recap to the server (starting it if needed), which queues it. */
async function deliver(body) {
  try { if (await post(body)) return; } catch {}
  startServer();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { if (await post(body)) return; } catch {}
  }
}

/** A notify command Codex had before claudespeak still gets the event. */
async function chainCodexNotify() {
  if (agent !== "codex" || !Array.isArray(cfg.codexNotifyChain) || !cfg.codexNotifyChain.length) return;
  const json = argv.findLast((a) => a.trim().startsWith("{"));
  const [cmd, ...args] = cfg.codexNotifyChain;
  if (json) await runCli(cmd, [...args, json], "", { timeout: 20_000 });
}

// ---- Main flow, last in the file: every constant and function above is defined by the time it runs.
// The summariser is itself an agent session: it must never speak.
if (process.env.CLAUDESPEAK_CHILD) process.exit(0);

const argv = process.argv.slice(2);
const named = argv[argv.indexOf("--agent") + 1];
const agent = AGENTS.includes(named) ? named : "claude";
const cfg = loadConfig();
if (fs.existsSync(OFF)) { await chainCodexNotify(); process.exit(0); }
const raw = rawEvent();
if (argv.includes("--detach") && !argv.includes("--print")) { detach(raw); process.exit(0); }
if (agent === "copilot") await new Promise((r) => setTimeout(r, 300));   // let Copilot finish writing its log
const event = readEvent(raw);
if (!event) { await chainCodexNotify(); process.exit(0); }

const project = projectOf(event.cwd);
const lang = langOf(cfg, project);
const summary = await summarize(event.text);
const said = summary ? { text: summary, lang } : { text: sayable(recap(event.text)), lang: lang === "en" ? "en" : "na" };
if (argv.includes("--print")) { console.log(`[${project} · ${said.lang}] ${said.text}`); process.exit(0); }
if (said.text) await deliver({ ...said, project });
await chainCodexNotify();
