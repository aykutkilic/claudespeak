// A plugin or npx cache is disposable. Install the shared voice runtime into a content-addressed,
// user-owned directory before writing hooks; never depend on the download's original location.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { HOME, ROOT, BASE, CLAUDE_DIR, CODEX_DIR, COPILOT_DIR } from "./config.mjs";
import { runCommand } from "./platform.mjs";

const RUNTIMES = path.join(HOME, "runtime");
const POINTER = path.join(RUNTIMES, "current.json");

/** Only shipped runtime inputs affect the installation identity; model weights stay shared. */
export function runtimeId(root = ROOT) {
  const hash = createHash("sha256");
  const add = (relative) => {
    const file = path.join(root, relative);
    if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file).sort()) add(path.join(relative, name));
    else hash.update(relative.replaceAll("\\", "/") + "\0").update(fs.readFileSync(file)).update("\0");
  };
  for (const entry of ["package.json", "bin", "src", "vendor", "skill"]) add(entry);
  return hash.digest("hex").slice(0, 20);
}

function runtimeRoot(id) { return path.join(RUNTIMES, id, "node_modules", "claudespeak"); }
function ready(id) {
  if (!/^[a-f0-9]{20}$/.test(id || "")) return false;
  const root = runtimeRoot(id);
  try {
    createRequire(path.join(root, "package.json")).resolve("onnxruntime-node");
    return fs.existsSync(path.join(root, "src", "hook.mjs")) && fs.existsSync(path.join(RUNTIMES, id, ".ready"));
  } catch { return false; }
}
export function managedRuntime() {
  try { const { id } = JSON.parse(fs.readFileSync(POINTER, "utf8")); return ready(id) ? runtimeRoot(id) : null; } catch { return null; }
}

const execute = runCommand;

/** Publish a complete installation atomically; a failed update keeps the previous runtime usable. */
export async function ensureRuntime({ source = ROOT, run = execute } = {}) {
  const id = runtimeId(source), destination = path.join(RUNTIMES, id);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const backend = `onnxruntime-node@${pkg.devDependencies["onnxruntime-node"]}`;
  fs.mkdirSync(RUNTIMES, { recursive: true });
  if (!ready(id)) {
    const staging = fs.mkdtempSync(path.join(RUNTIMES, ".install-"));
    try {
      fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ private: true, name: "claudespeak-runtime" }));
      console.log("Installing the shared claudespeak runtime…");
      await run("npm", ["install", "--prefix", staging, "--install-links", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", source, backend],
        { ONNXRUNTIME_NODE_INSTALL: "skip" });
      const installed = path.join(staging, "node_modules", "claudespeak");
      if (fs.lstatSync(installed).isSymbolicLink()) throw new Error("runtime must be copied, not linked to a download cache");
      createRequire(path.join(installed, "package.json")).resolve("onnxruntime-node");
      if (!fs.existsSync(path.join(installed, "src", "hook.mjs"))) throw new Error("incomplete runtime package");
      fs.writeFileSync(path.join(staging, ".ready"), id);
      try { fs.renameSync(staging, destination); }
      catch (e) { if (!ready(id)) throw e; } // another setup finished the same version first
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const pointer = `${POINTER}.${process.pid}.tmp`;
  try { fs.writeFileSync(pointer, JSON.stringify({ id }) + "\n"); fs.renameSync(pointer, POINTER); }
  finally { fs.rmSync(pointer, { force: true }); }
  return runtimeRoot(id);
}

/** Existing direct hooks win, so adding a native plugin doesn't speak the same recap twice. */
export function legacyHook(agent) {
  try {
    if (agent === "claude") return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, "settings.json"), "utf8"))
      .hooks?.Stop?.some((g) => g.hooks?.some((h) => h.command?.includes("--claudespeak"))) || false;
    if (agent === "codex") return (fs.readFileSync(path.join(CODEX_DIR, "config.toml"), "utf8").split(/^\s*\[/m)[0]
      .match(/^\s*notify\s*=\s*\[[\s\S]*?\]/m)?.[0] || "").includes("--claudespeak");
    if (agent === "copilot") return fs.readFileSync(path.join(COPILOT_DIR, "hooks", "claudespeak.json"), "utf8").includes("--claudespeak");
  } catch {}
  return false;
}

export async function setup(args) {
  const root = await ensureRuntime();
  await execute(process.execPath, [path.join(root, "bin", "claudespeak.mjs"), "install", ...args]);
}

/** Plugin entry point: setup is explicit; turn-end hooks never install dependencies or download models. */
export async function pluginMain([command, ...args]) {
  if (command === "hook" && (process.env.CLAUDESPEAK_CHILD || legacyHook(args[0]))) return;
  let root = managedRuntime();
  if (command === "setup") {
    root = await ensureRuntime();
    await execute(process.execPath, [path.join(root, "bin", "claudespeak.mjs"), "install", "--models-only"]);
    try { await fetch(BASE + "/quit", { signal: AbortSignal.timeout(1000) }); } catch {}
    console.log("claudespeak is ready. Use the speak skill to change settings or play a test.");
    return;
  }
  if (!root) {
    if (command !== "hook") throw new Error("Run the plugin's setup skill first (or use the standalone setup command).");
    return;
  }
  if (command === "hook") {
    if (!["claude", "codex", "copilot"].includes(args[0])) throw new Error("unknown plugin agent");
    return execute(process.execPath, [path.join(root, "src", "hook.mjs"), "--agent", args[0], "--detach", "--claudespeak"]);
  }
  return execute(process.execPath, [path.join(root, "bin", "claudespeak.mjs"), command || "toggle", ...args]);
}
