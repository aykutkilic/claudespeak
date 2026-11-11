// Opt-in network check: a real tarball, npx setup, cache removal and uninstall in a temporary home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claudespeak packaged install "));
const home = path.join(scratch, "home"); fs.mkdirSync(home);
const cache = path.join(scratch, "cache");
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"),
  npm_config_cache: cache, CLAUDESPEAK_HOME: path.join(home, ".claudespeak"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  CODEX_HOME: path.join(home, ".codex"), COPILOT_HOME: path.join(home, ".copilot"), OPENCODE_CONFIG_DIR: path.join(home, "opencode"),
  CLAUDESPEAK_PORT: "0" };
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run with npm run test:install");
const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const executable = cmd === "npm" ? process.execPath : cmd;
  const argv = cmd === "npm" ? [npmCli, ...args] : args;
  const p = spawn(executable, argv, { env, cwd: process.cwd() }); let output = "";
  p.stdout.on("data", (c) => output += c); p.stderr.on("data", (c) => output += c);
  p.once("error", reject); p.once("exit", (code) => code ? reject(new Error(output)) : resolve(output));
  p.stdin.end(input);
});
try {
  const packed = await run("npm", ["pack", "--json", "--pack-destination", scratch, "--ignore-scripts", "--no-audit", "--no-fund"]);
  const pack = JSON.parse(packed.slice(packed.indexOf("[")))[0];
  const paths = new Set(pack.files.map((f) => f.path));
  for (const file of ["src/server.mjs", "src/speech.mjs", "src/audio.mjs", "src/bootstrap.mjs", "scripts/plugin.mjs", "skill/SKILL.md",
    "skills/speak/SKILL.md", "skills/setup/SKILL.md", "vendor/supertonic/helper.js", "vendor/supertonic/LICENSE", "plugin.json",
    ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "com.github.copilot/hooks/hooks.json"]) assert.ok(paths.has(file), `missing ${file}`);
  assert.ok(!pack.files.some((f) => f.path.endsWith(".onnx") || f.path.startsWith("node_modules/")));
  assert.ok(pack.size < 1024 * 1024, "initial download stays small");
  const tarball = path.join(scratch, pack.filename);
  fs.mkdirSync(env.CODEX_HOME, { recursive: true }); fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), 'notify = ["old-notifier"]\n');
  console.log(`Packed ${pack.files.length} files, ${pack.size} bytes. Running real npm setup in an isolated home…`);
  const setup = await run("npm", ["exec", "--yes", `--package=${tarball}`, "--", "claudespeak", "setup", "--no-models", "--claude", "--codex", "--copilot", "--opencode"]);
  const { id } = JSON.parse(fs.readFileSync(path.join(env.CLAUDESPEAK_HOME, "runtime", "current.json")));
  const root = path.join(env.CLAUDESPEAK_HOME, "runtime", id, "node_modules", "claudespeak");
  const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json")));
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes(root));
  assert.ok(!fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(cache, { recursive: true, force: true });
  await run(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]);",
    pathToFileURL(path.join(root, "vendor", "supertonic", "helper.js")).href]);
  const configFile = path.join(env.CLAUDESPEAK_HOME, "config.json");
  const config = JSON.parse(fs.readFileSync(configFile));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, lang: "en", summarizer: "none" }));
  const said = await run(process.execPath, [path.join(root, "src", "hook.mjs"), "--agent", "codex", "--print",
    JSON.stringify({ type: "agent-turn-complete", cwd: process.cwd(), "last-assistant-message": "Managed installation works." })]);
  assert.match(said, /Managed installation works/);
  await run(process.execPath, [path.join(root, "bin", "claudespeak.mjs"), "uninstall"]);
  assert.match(fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8"), /notify = \["old-notifier"\]/);
  console.log(setup.trim());
  console.log("Real packaged setup passed for all four agents; runtime survived deleting the npm cache; uninstall restored notify.");
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
