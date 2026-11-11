import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudespeak-distribution-"));
process.env.CLAUDESPEAK_HOME = path.join(temp, "home");
process.env.CLAUDE_CONFIG_DIR = path.join(temp, "claude");
process.env.CODEX_HOME = path.join(temp, "codex");
process.env.COPILOT_HOME = path.join(temp, "copilot");
const { runtimeId, ensureRuntime, managedRuntime, legacyHook, pluginMain } = await import("../src/bootstrap.mjs");

try {
  // Plugin files must be ready in a Git download, without npm lifecycle scripts or build steps.
  const generated = spawnSync(process.execPath, [path.join(root, "scripts", "build-plugins.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const portable = JSON.parse(fs.readFileSync(path.join(root, "plugin.json")));
  assert.equal(portable.extensions["com.openai"].hooks, "./hooks/codex.json");
  for (const relative of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json",
    "hooks/hooks.json", "hooks/codex.json", "com.github.copilot/hooks/hooks.json"]) JSON.parse(fs.readFileSync(path.join(root, relative)));

  // No setup means no turn-end downloads, writes, or child processes.
  await pluginMain(["hook", "claude"]);
  assert.equal(managedRuntime(), null);
  assert.ok(!fs.existsSync(process.env.CLAUDESPEAK_HOME));

  const source = path.join(temp, "download cache with spaces");
  fs.mkdirSync(source);
  for (const entry of ["package.json", "bin", "src", "vendor", "skill"]) fs.cpSync(path.join(root, entry), path.join(source, entry), { recursive: true });
  const id = runtimeId(source);
  let installs = 0;
  const fakeInstall = async (cmd, args, env) => {
    installs++;
    assert.equal(cmd, "npm"); assert.ok(args.includes("--install-links")); assert.ok(args.includes("--omit=dev"));
    assert.equal(env.ONNXRUNTIME_NODE_INSTALL, "skip", "skip CUDA regardless of the invoking project's npm config");
    const stage = args[args.indexOf("--prefix") + 1];
    const modules = path.join(stage, "node_modules");
    fs.mkdirSync(modules);
    fs.cpSync(source, path.join(modules, "claudespeak"), { recursive: true });
    fs.mkdirSync(path.join(modules, "onnxruntime-node"));
    fs.writeFileSync(path.join(modules, "onnxruntime-node", "package.json"), '{"name":"onnxruntime-node","main":"index.js"}');
    fs.writeFileSync(path.join(modules, "onnxruntime-node", "index.js"), "module.exports = {};\n");
  };
  const installed = await ensureRuntime({ source, run: fakeInstall });
  assert.equal(installs, 1); assert.equal(managedRuntime(), installed);
  assert.equal(runtimeId(installed), id, "installed runtime matches the downloaded inputs");
  await ensureRuntime({ source, run: () => assert.fail("same runtime installed twice") });
  fs.appendFileSync(path.join(source, "src", "text.mjs"), "\n// changed runtime\n");
  assert.notEqual(runtimeId(source), id, "code changes refresh the runtime even before a version bump");
  await assert.rejects(ensureRuntime({ source, run: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(managedRuntime(), installed, "a failed update keeps the previous runtime selected");
  assert.ok(!fs.readdirSync(path.dirname(path.dirname(path.dirname(installed)))).some((name) => name.startsWith(".install-")));

  // Download/plugin caches can disappear after setup; hooks still target a complete durable copy.
  fs.rmSync(source, { recursive: true });
  const help = spawnSync(process.execPath, [path.join(installed, "bin", "claudespeak.mjs"), "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /spoken summaries/);

  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "node old-hook --claudespeak" }] }] } }));
  assert.ok(legacyHook("claude"));
  assert.equal(legacyHook("codex"), false);
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'notify = [\n"node",\n"hook.mjs",\n"--claudespeak"\n]\n[projects]\n');
  assert.equal(legacyHook("codex"), true, "detect multiline notify commands too");
  const hook = spawnSync(process.execPath, [path.join(root, "scripts", "plugin.mjs"), "hook", "claude"], {
    env: process.env, input: "{}", encoding: "utf8",
  });
  assert.equal(hook.status, 0); assert.equal(hook.stdout, "", "native hook defers to an existing direct hook");
  fs.writeFileSync(settings, '{"hooks":{"Stop":[{"hooks":[{"command":"echo mine"}]}]}}');
  assert.equal(legacyHook("claude"), false, "unrelated hooks don't suppress the plugin");

  console.log("distribution tests passed");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
