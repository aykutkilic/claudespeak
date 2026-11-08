// What differs between macOS, Windows and Linux: playing a WAV, a fallback system voice, running a
// CLI (claude / codex are .cmd shims on Windows), and starting the server at login.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME, LOG, ROOT } from "./config.mjs";

const WIN = process.platform === "win32", MAC = process.platform === "darwin";

export function has(cmd) {
  return spawnSync(WIN ? "where" : "which", [cmd], { stdio: "ignore", windowsHide: true }).status === 0;
}

/** The command that plays a WAV file to the end, or null if none is found. */
export function playerFor(file) {
  if (MAC) return ["afplay", [file]];
  if (WIN) return ["powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]];
  for (const [cmd, args] of [["pw-play", [file]], ["paplay", [file]], ["aplay", ["-q", file]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]]]) if (has(cmd)) return [cmd, args];
  return null;
}
export function playerName() { const p = playerFor("x.wav"); return p ? p[0] : "none"; }

/** The OS's own voice, used only if Supertonic can't load. Text goes in through the environment. */
export function systemSpeech(text) {
  if (MAC) return ["say", [text], {}];
  if (WIN) return ["powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:CLAUDESPEAK_TEXT)"],
    { CLAUDESPEAK_TEXT: text }];
  if (has("spd-say")) return ["spd-say", ["-w", text], {}];
  if (has("espeak-ng")) return ["espeak-ng", [text], {}];
  return null;
}

/** Runs a CLI with text on stdin; resolves to its stdout, or "" on failure or timeout. */
export function runCli(cmd, args, input, { env = {}, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    // On Windows the CLIs are .cmd shims, so they go through the shell: quote each argument.
    const q = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    const p = WIN ? spawn([cmd, ...args].map(q).join(" "), { shell: true, env: { ...process.env, ...env }, windowsHide: true })
      : spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    const timer = setTimeout(() => { p.kill(); resolve(""); }, timeout);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", () => {});
    p.on("error", () => { clearTimeout(timer); resolve(""); });
    p.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? out : ""); });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

/** Starts the server in the background (the hook does this when it finds none). */
export function startServer() {
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(LOG, "a");
  spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], { detached: true, stdio: ["ignore", log, log], windowsHide: true }).unref();
}

// ---- Start at login: launchd (macOS), a hidden Startup-folder script (Windows), systemd --user (Linux).
const LABEL = "com.claudespeak.server";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const STARTUP = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "claudespeak.vbs");
const UNIT = path.join(os.homedir(), ".config", "systemd", "user", "claudespeak.service");
const SERVER = path.join(ROOT, "src", "server.mjs");

export function autostartStatus() {
  if (MAC) return spawnSync("launchctl", ["print", `gui/${os.userInfo().uid}/${LABEL}`], { stdio: "ignore" }).status === 0;
  if (WIN) return fs.existsSync(STARTUP);
  return spawnSync("systemctl", ["--user", "is-enabled", "claudespeak.service"], { stdio: "ignore" }).status === 0;
}

export function autostart(on) {
  const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (MAC) {
    const uid = os.userInfo().uid;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    if (!on) { fs.rmSync(PLIST, { force: true }); return; }
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(SERVER)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`);
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("launchctl: " + (r.stderr || r.stdout).trim());
    return;
  }
  if (WIN) {
    if (!on) { fs.rmSync(STARTUP, { force: true }); return; }
    const vb = (s) => s.replace(/"/g, '""');
    fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
    fs.writeFileSync(STARTUP, `CreateObject("WScript.Shell").Run """${vb(process.execPath)}"" ""${vb(SERVER)}""", 0, False\r\n`);
    spawnSync("wscript", [STARTUP], { stdio: "ignore", windowsHide: true });
    return;
  }
  if (!has("systemctl")) throw new Error("systemd not found; start `node " + SERVER + "` from your desktop's autostart instead");
  if (!on) {
    spawnSync("systemctl", ["--user", "disable", "--now", "claudespeak.service"], { stdio: "ignore" });
    fs.rmSync(UNIT, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, `[Unit]
Description=claudespeak voice server
After=sound.target

[Service]
ExecStart="${process.execPath}" "${SERVER}"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "claudespeak.service"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("systemctl: " + (r.stderr || r.stdout).trim());
}
