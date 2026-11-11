// Keep native manifests and skills in sync with the package and the canonical command template.
// Generated files are committed so installing a Git plugin requires no build step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const metadata = { name: pkg.name, version: pkg.version, description: pkg.description,
  author: { name: pkg.author }, homepage: "https://github.com/aykutkilic/claudespeak#readme",
  repository: "https://github.com/aykutkilic/claudespeak", license: pkg.license, keywords: pkg.keywords };
const files = new Map();
const json = (file, value) => files.set(file, JSON.stringify(value, null, 2) + "\n");
json("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...metadata,
  extensions: { "com.openai": { hooks: "./hooks/codex.json" } } });
json(".claude-plugin/plugin.json", metadata);
json(".claude-plugin/marketplace.json", { name: "claudespeak", description: "Local spoken summaries for coding agents", owner: { name: pkg.author },
  plugins: [{ name: pkg.name, source: "./", description: pkg.description }] });
json(".agents/plugins/marketplace.json", { name: "claudespeak", interface: { displayName: "claudespeak" },
  plugins: [{ name: pkg.name, source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] });
const stop = (variable, agent, extra = {}) => ({ hooks: { Stop: [{ hooks: [{ type: "command",
  command: `node "\${${variable}}/scripts/plugin.mjs" hook ${agent}`, timeout: 15, ...extra }] }] } });
json("hooks/hooks.json", stop("CLAUDE_PLUGIN_ROOT", "claude", { async: true }));
json("hooks/codex.json", stop("PLUGIN_ROOT", "codex"));
json("com.github.copilot/hooks/hooks.json", { version: 1, hooks: { agentStop: [{ type: "command",
  bash: 'node "${COPILOT_PLUGIN_ROOT}/scripts/plugin.mjs" hook copilot',
  powershell: 'node "${env:COPILOT_PLUGIN_ROOT}/scripts/plugin.mjs" hook copilot', timeoutSec: 15 }] } });

const locate = "Resolve `../../scripts/plugin.mjs` relative to this SKILL.md's directory to get the plugin entry point. " +
  "Use its absolute path (quoted) in every command below. The plugin shares a durable runtime in `~/.claudespeak`; " +
  "the working directory remains the user's project.\n\n";
const cli = 'node "<absolute plugin entry point>"';
files.set("skills/speak/SKILL.md", "---\nname: speak\ndescription: Configure claudespeak spoken summaries, voices, language, pronunciation, speed and audio effects.\n---\n\n" + locate +
  "If setup is missing, explain that the setup skill installs the runtime and voice model, and run it when requested.\n\n" +
  fs.readFileSync(path.join(root, "skill", "SKILL.md"), "utf8").replaceAll("{{CLI}}", cli));
files.set("skills/setup/SKILL.md", "---\nname: setup\ndescription: Install or update the shared claudespeak voice runtime and local model for this plugin.\n---\n\n" + locate +
  `Run \`${cli} setup\`. This installs Node dependencies into a user-owned runtime directory and downloads ` +
  "the approximately 410 MB Supertonic model once. It does not edit the agent's hook configuration: the plugin supplies its hooks. " +
  "Run the same command again to update the shared runtime from this plugin version.\n\n" +
  `After setup succeeds, run \`${cli} test\` so the user can hear a short sample, and report the result.\n`);

let stale = false;
for (const [relative, content] of files) {
  const file = path.join(root, relative);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) { console.error(`Regenerate ${relative}: node scripts/build-plugins.mjs`); stale = true; }
  } else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
}
if (stale) process.exitCode = 1;
