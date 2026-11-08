// Smoke test: install into a throwaway home (existing Claude / Codex settings must survive), drive the CLI,
// run the hook without a summariser, uninstall, and (with SMOKE_TTS=1 and the models downloaded) synthesise
// one sentence. `npm test`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "claudespeak-smoke-"));
const env = {
  ...process.env, HOME: T, USERPROFILE: T, APPDATA: path.join(T, "AppData"),
  CLAUDESPEAK_HOME: path.join(T, ".claudespeak"), CLAUDE_CONFIG_DIR: path.join(T, ".claude"),
  CODEX_HOME: path.join(T, ".codex"), CLAUDESPEAK_PORT: "7896",
};
const cli = (...a) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "claudespeak.mjs"), ...a], { env, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `claudespeak ${a.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const settings = path.join(T, ".claude", "settings.json"), toml = path.join(T, ".codex", "config.toml");

fs.mkdirSync(path.dirname(settings), { recursive: true });
fs.mkdirSync(path.dirname(toml), { recursive: true });
fs.writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
fs.writeFileSync(toml, 'model = "x"\nnotify = ["my-notifier", "--flag"]\n\n[profiles.a]\nmodel = "y"\n');

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

// The CLI edits the config; bad values are refused.
assert.match(cli("voice", "m5"), /M5/);
assert.match(cli("lang", "en", "."), /English/);
assert.match(cli("reverb", "wet", "0.3"), /wet 0.3/);
assert.match(cli("model", "none"), /nobody/);
const bad = spawnSync(process.execPath, [path.join(ROOT, "bin", "claudespeak.mjs"), "speed", "9"], { env, encoding: "utf8" });
assert.notEqual(bad.status, 0);
assert.match(cli("status"), /M5/);

// The hook, with no summariser: the first sentence, made sayable.
const event = JSON.stringify({ cwd: ROOT, last_assistant_message: "Fixed `src/a.ts:12` in 3.5 ms. More text here." });
const h = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "claude", "--print"], { env, input: event, encoding: "utf8" });
assert.equal(h.status, 0, h.stderr);
assert.match(h.stdout, /Fixed a in three point five milliseconds\./);
const c = spawnSync(process.execPath, [path.join(ROOT, "src", "hook.mjs"), "--agent", "codex", "--print",
  JSON.stringify({ type: "agent-turn-complete", cwd: ROOT, "last-assistant-message": "All done." })], { env, encoding: "utf8" });
assert.equal(c.status, 0, c.stderr);
assert.match(c.stdout, /All done\./);

// Uninstall puts things back.
cli("uninstall");
s = json(settings);
assert.equal(s.hooks.Stop.length, 1);
assert.equal(s.hooks.Stop[0].hooks[0].command, "echo mine");
t = fs.readFileSync(toml, "utf8");
assert.match(t, /^notify = \["my-notifier","--flag"]$/m);
assert.ok(!fs.existsSync(path.join(T, ".claude", "skills", "speak")));

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
