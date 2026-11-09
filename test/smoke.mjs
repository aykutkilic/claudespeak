// Smoke test: install into a throwaway home (existing Claude / Codex / Copilot / opencode settings must survive), drive the CLI,
// run the hook without a summariser, uninstall, and (with SMOKE_TTS=1 and the models downloaded) synthesise
// one sentence. `npm test`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "claudespeak-smoke-"));
const env = {
  ...process.env, HOME: T, USERPROFILE: T, APPDATA: path.join(T, "AppData"),
  CLAUDESPEAK_HOME: path.join(T, ".claudespeak"), CLAUDE_CONFIG_DIR: path.join(T, ".claude"),
  CODEX_HOME: path.join(T, ".codex"), COPILOT_HOME: path.join(T, ".copilot"),
  OPENCODE_CONFIG_DIR: path.join(T, "opencode"), CLAUDESPEAK_PORT: "7896",
};
const cli = (...a) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "claudespeak.mjs"), ...a], { env, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `claudespeak ${a.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const settings = path.join(T, ".claude", "settings.json"), toml = path.join(T, ".codex", "config.toml");
const copilotHooks = path.join(T, ".copilot", "hooks"), myCopilotHook = path.join(copilotHooks, "mine.json");
const ocPlugins = path.join(T, "opencode", "plugins"), myOcPlugin = path.join(ocPlugins, "mine.js");
const ocCommand = path.join(T, "opencode", "commands", "speak.md");

fs.mkdirSync(path.dirname(settings), { recursive: true });
fs.mkdirSync(path.dirname(toml), { recursive: true });
fs.writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
fs.writeFileSync(toml, 'model = "x"\nnotify = ["my-notifier", "--flag"]\n\n[profiles.a]\nmodel = "y"\n');
fs.mkdirSync(copilotHooks, { recursive: true });
fs.writeFileSync(myCopilotHook, JSON.stringify({ version: 1, hooks: { agentStop: [{ type: "command", bash: "echo mine" }] } }));
fs.mkdirSync(ocPlugins, { recursive: true });
fs.writeFileSync(myOcPlugin, "export default { id: 'mine', server: async () => ({}) };\n");

// Install twice: one hook of ours, the user's kept, Codex's old notify chained.
cli("install", "--no-models");
cli("install", "--no-models");
let s = json(settings);
assert.equal(s.model, "opus");
assert.equal(s.hooks.Stop.length, 2);
assert.match(s.hooks.Stop[1].hooks[0].command, /hook\.mjs.*--agent claude/);
let t = fs.readFileSync(toml, "utf8");
assert.equal((t.match(/^notify/gm) || []).length, 1);
assert.match(t, /hook\.mjs.*--agent.*codex/);
assert.match(t, /\[profiles\.a]/);
assert.deepEqual(json(path.join(T, ".claudespeak", "config.json")).codexNotifyChain, ["my-notifier", "--flag"]);
assert.ok(fs.existsSync(path.join(T, ".claude", "skills", "speak", "SKILL.md")));
assert.ok(fs.existsSync(path.join(T, ".agents", "skills", "speak", "SKILL.md")));

// Copilot CLI: a hooks file of our own next to the user's, and the skill.
const ours = json(path.join(copilotHooks, "claudespeak.json"));
assert.equal(ours.version, 1);
assert.equal(ours.hooks.agentStop.length, 1);
assert.match(ours.hooks.agentStop[0].bash, /hook\.mjs'? '--agent' 'copilot' '--detach'/);
assert.match(ours.hooks.agentStop[0].powershell, /^& '.*hook\.mjs'/);
assert.equal(json(myCopilotHook).hooks.agentStop[0].bash, "echo mine");
assert.ok(fs.existsSync(path.join(T, ".copilot", "skills", "speak", "SKILL.md")));

// opencode: the plugin, filled in and loadable (2.x's setup() and 1.x's server()), next to the user's; the command.
const ocPlugin = path.join(ocPlugins, "claudespeak.js");
assert.ok(!fs.readFileSync(ocPlugin, "utf8").includes("{{"));
const plugin = (await import(pathToFileURL(ocPlugin).href)).default;
assert.equal(plugin.id, "claudespeak");
assert.equal(typeof plugin.setup, "function");
assert.equal(typeof plugin.server, "function");
assert.equal(plugin.lastText([{ type: "user", text: "hi" }, { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Two." }] }, { type: "idle" }]), "Two.");
assert.equal(plugin.lastText([{ info: { role: "assistant" }, parts: [{ type: "text", text: "One." }] }, { info: { role: "user" }, parts: [] }]), "One.");
assert.ok(fs.existsSync(myOcPlugin));
assert.match(fs.readFileSync(ocCommand, "utf8"), /^---\ndescription: [^\n]+\n---[\s\S]*\$ARGUMENTS/);

// The CLI edits the config; bad values are refused.
// A fresh config takes the OS language, or English when Supertonic doesn't speak it.
const { systemLang, LANGS } = await import(new URL("../src/config.mjs", import.meta.url));
const fresh = json(path.join(T, ".claudespeak", "config.json")).lang;
assert.equal(fresh, systemLang());
assert.ok(LANGS[fresh] && fresh !== "na");
assert.match(cli("voice", "m5"), /M5/);
assert.match(cli("lang", "en", "."), /English/);
assert.match(cli("reverb", "wet", "0.3"), /wet 0.3/);
assert.match(cli("model", "none"), /nobody/);
const bad = spawnSync(process.execPath, [path.join(ROOT, "bin", "claudespeak.mjs"), "speed", "9"], { env, encoding: "utf8" });
assert.notEqual(bad.status, 0);
assert.match(cli("status"), /M5/);
assert.match(cli("pronounce", "GraphQL", "graf", "kyu", "el", "--lang", "tr"), /graf kyu el/);
assert.match(cli("pronunciations", "--lang", "tr"), /GraphQL → graf kyu el/);
const { pronounce } = await import(new URL("../src/config.mjs", import.meta.url));
assert.equal(pronounce(json(path.join(T, ".claudespeak", "config.json")), "graphql şeması, GraphQLx değil", "tr"), "graf kyu el şeması, GraphQLx değil");
cli("unpronounce", "graphql", "--lang", "tr");

// The hook, with no summariser: the first sentence, made sayable.
const event = JSON.stringify({ cwd: ROOT, last_assistant_message: "Fixed `src/a.ts:12` in 3.5 ms. More text here." });
const h = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "claude", "--print"], { env, input: event, encoding: "utf8" });
assert.equal(h.status, 0, h.stderr);
assert.match(h.stdout, /Fixed a in three point five milliseconds\./);
const c = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "codex", "--print",
  JSON.stringify({ type: "agent-turn-complete", cwd: ROOT, "last-assistant-message": "All done." })], { env, encoding: "utf8" });
assert.equal(c.status, 0, c.stderr);
assert.match(c.stdout, /All done\./);
// Copilot's event names the session; the message comes from its events.jsonl.
const log = path.join(T, ".copilot", "session-state", "s1", "events.jsonl");
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.writeFileSync(log, [{ type: "user.message", data: { content: "go" } }, { type: "assistant.message", data: { content: "Copilot is done." } },
  { type: "assistant.message", data: { content: "A subagent's note.", parentToolCallId: "t1" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
const cp = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "copilot", "--detach", "--print"],
  { env, input: JSON.stringify({ sessionId: "s1", cwd: ROOT, stopReason: "end_turn" }), encoding: "utf8" });
assert.equal(cp.status, 0, cp.stderr);
assert.match(cp.stdout, /Copilot is done\./);
const oc = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "opencode", "--print"],
  { env, input: JSON.stringify({ cwd: ROOT, last_assistant_message: "Opencode is done." }), encoding: "utf8" });
assert.equal(oc.status, 0, oc.stderr);
assert.match(oc.stdout, /Opencode is done\./);

// Uninstall puts things back.
cli("uninstall");
s = json(settings);
assert.equal(s.hooks.Stop.length, 1);
assert.equal(s.hooks.Stop[0].hooks[0].command, "echo mine");
t = fs.readFileSync(toml, "utf8");
assert.match(t, /^notify = \["my-notifier","--flag"]$/m);
assert.ok(!fs.existsSync(path.join(T, ".claude", "skills", "speak")));
assert.ok(!fs.existsSync(path.join(copilotHooks, "claudespeak.json")));
assert.ok(fs.existsSync(myCopilotHook));
assert.ok(!fs.existsSync(path.join(T, ".copilot", "skills", "speak")));
assert.ok(!fs.existsSync(ocPlugin));
assert.ok(fs.existsSync(myOcPlugin));
assert.ok(!fs.existsSync(ocCommand));

// Supertonic itself, if asked (CI downloads the models first).
if (process.env.SMOKE_TTS) {
  const models = process.env.SMOKE_MODELS || path.join(os.homedir(), ".claudespeak", "models");
  const { loadTextToSpeech, loadVoiceStyle } = await import(new URL("../vendor/supertonic/helper.js", import.meta.url));
  const tts = await loadTextToSpeech(path.join(models, "onnx"));
  const { wav, duration } = await tts.call("Hello from claudespeak.", "en", loadVoiceStyle([path.join(models, "voice_styles", "F5.json")]), 6, 1.05);
  assert.ok(duration[0] > 0.5 && wav.length > tts.sampleRate * 0.5, "synthesis produced audio");
  console.log(`synthesised ${duration[0].toFixed(2)} s`);
}

fs.rmSync(T, { recursive: true, force: true });
console.log("smoke test passed");
