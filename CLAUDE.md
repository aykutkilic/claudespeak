# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

claudespeak reads a one- or two-sentence spoken summary aloud when a coding agent's turn ends, and gives that
agent a `/speak` command (`$speak` in Codex) to configure it. It uses Supertonic 3, a local ONNX text-to-speech
model. It is plain Node ESM (`.mjs`, Node ≥ 20) with one inference dependency (`onnxruntime-node`). There is no
build step, no bundler, no TypeScript and no linter.

**Scope:** it is meant to work with any coding agent (Claude Code, Codex, GitHub Copilot, opencode, and so
on) on macOS, Linux and Windows. Claude Code, Codex, Copilot CLI and opencode (1.x and 2.x) are wired up. Every
change must keep working on all three operating systems, and CI checks this.

## Commands

```sh
npm install                                   # .npmrc skips onnxruntime's CUDA download
npm test                                      # smoke, speech scheduling and distribution checks; no per-test runner
node scripts/build-plugins.mjs                # regenerate committed plugin manifests and skills
npm run test:install                         # real packaged npx setup/uninstall in a temporary home (network)
SMOKE_TTS=1 npm test                          # also checks real synthesis and progressive output (needs models)
node bin/claudespeak.mjs install --models-only   # download the ~410 MB model to ~/.claudespeak/models
node bin/claudespeak.mjs <cmd>                # the CLI (status, doctor, test, restart, …; `help` lists all)
```

Check the hook's output without the server or audio:

```sh
echo '{"cwd":".","last_assistant_message":"Fixed it."}' | node src/hook.mjs --agent claude --print
node src/hook.mjs --agent codex --print '{"type":"agent-turn-complete","cwd":".","last-assistant-message":"Done."}'
```

`--print` still calls the summariser CLI unless `model none` is set.

The smoke test points every path into a throwaway temporary home through environment variables, so it never
touches the real setup. Keep it that way when adding tests. The variables are `HOME`/`USERPROFILE`/`APPDATA`,
`CLAUDESPEAK_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR` and `CLAUDESPEAK_PORT`.
CI runs the smoke test with `SMOKE_TTS=1` and the packaged installer check on macOS, Windows and Linux.

A running server keeps the code it started with. After changing `src/server.mjs` (or anything it imports), run
`node bin/claudespeak.mjs restart`. The next summary or `test` starts a fresh server.

## Architecture

The data flow runs from the agent to the hook, then the summariser, then the server, and finally the speaker:

- **`src/hook.mjs`**: the entry point the agents call. Claude Code runs it as an async `Stop` hook and passes
  the event JSON on stdin; Codex runs it as `notify` and appends the event JSON as the last argv. Copilot CLI
  runs it as an `agentStop` hook with `--detach`: the hook passes the stdin event to a detached copy of itself
  in `CLAUDESPEAK_EVENT`, because Copilot waits for its hooks. That copy reads the message from the session's
  `events.jsonl` (`copilotMessage` in `text.mjs`). opencode's plugin pipes `{ cwd, last_assistant_message }` on
  stdin. It shells out to `claude -p`, `codex exec`, `copilot -p` or `opencode run` to write the summary. If that fails, it falls back to `text.mjs` (`recap` +
  `sayable`). It then POSTs to the server, starting the server if it isn't up. The file is a script, and its
  main flow sits at the bottom, after every constant and function it uses. Keep that order.
  - Recursion guard: the summariser runs with `CLAUDESPEAK_CHILD=1`, and the hook exits at once when it sees
    it. Any new agent spawn must set it too.
  - For non-English languages the prompt asks for a `TERMS:` line and a `SAY:` line, and only `SAY` is spoken.
    The prompt rules (`SOUND_EXAMPLES`, `LETTERS`, `FOREIGN_MARKS`, the user's lexicon) make the model respell
    foreign terms in the target language's letters.
- **`src/server.mjs`**: an HTTP server on `127.0.0.1:7841` with `/say`, `/skip`, `/stop`, `/quit`, `/status`
  and `/health`.
  - It snapshots voice, language and settings per recap and shares one engine-loading promise. It writes
    each synthesized phrase to a temporary WAV and hands it to the platform's player.
  - If the port is already taken, it exits quietly, so duplicate starts are harmless.
  - `play.lock` in `CLAUDESPEAK_HOME` holds the server and player PIDs. It keeps playback to one voice at a
    time across processes, including old servers from other checkouts.
  - `quit()` sends itself `SIGKILL`, because a normal exit hangs on onnxruntime's threads.
- **`src/speech.mjs`**: the progressive synthesis/playback queue. A short first phrase minimizes startup
  latency; subsequent budgets use measured inference time and playable audio duration. Prefer sentence/clause
  boundaries, then word boundaries, and cap chunks at 300 characters (120 for Japanese/Korean).
  - Keep inference serial, and prefetch only one chunk. Hold the machine-wide playback lock across a recap.
  - Skip/stop abort playback and discard remaining chunks, including late inference results and queued WAVs.
    ONNX inference itself cannot be interrupted. Items older than 3 minutes are dropped before playback.
  - `test/speech.mjs` uses gated promises to check overlap, bounded buffering, FIFO, cancellation and cleanup
    without a model or audio device. `test/smoke.mjs` also checks real progressive inference with `SMOKE_TTS=1`.
- **`src/audio.mjs`**: stateful pure-JS compressor, per-project chimes (from a seeded hash of the project
  name), Freeverb-style reverb and peak ceiling, plus WAV encoding. Preserve compressor/reverb state across
  chunks; add an intro only to the first chunk, and the outro/reverb tail only to the last.
- **`src/config.mjs`**: shared paths, defaults and `~/.claudespeak/config.json`.
  - `loadConfig()` deep-merges the file over `DEFAULTS`. Add new nested settings to that merge too.
  - The server re-reads the file when its mtime changes, so CLI edits apply without a restart. The server also
    writes the file itself, when a new project takes its voice from `rotation`.
  - A "project" is the basename of the git root.
  - `pronounce()` applies the per-language lexicon on the server before synthesis.
  - The `off` file in the home folder is the on/off switch.
- **`src/cli.mjs`**: every user command (one big `switch`), with value ranges in `RANGE`. The `/speak` and
  `$speak` skills and the opencode `/speak` command just run this CLI.
- **`src/install.mjs`**: downloads the model, pinned to a Hugging Face commit with expected file sizes, and wires
  up the agents.
  - Claude: a `Stop` hook entry in `settings.json`. Codex: a top-level `notify` line in `config.toml`, found and
    edited with a small TOML scanner rather than a parser. Copilot CLI: a hooks file of its own,
    `~/.copilot/hooks/claudespeak.json`. opencode: `plugins/claudespeak.js`, copied from the template
    `src/opencode-plugin.js` with the Node and hook paths filled in.
  - The opencode plugin runs inside opencode (Bun), not Node. Its default export serves both loaders: 2.x calls
    `setup(ctx)` and reads `ctx.event.subscribe()` (an undocumented API, found by probing 2.1.3: the turn ends at
    `session.execution.succeeded`, and the text comes from `ctx.session.context`). 1.x calls `server()` and gets
    `session.idle`.
  - The entries it adds are tagged with the `--claudespeak` marker so they can be found and removed again.
  - A `notify` command Codex already had is saved as `codexNotifyChain`. The hook runs it after itself, and
    uninstall restores it.
  - Files are backed up to `*.claudespeak-backup` before writing.
  - `skill/SKILL.md` is a template. `{{CLI}}` is replaced with this checkout's absolute CLI command, and an
    agent-specific frontmatter is added on top.
- **`src/platform.mjs`**: everything that differs by OS.
  - Audio players: `afplay`; PowerShell `SoundPlayer`; `pw-play`, `paplay`, `aplay` or `ffplay`. The OS's own
    voice is the fallback when Supertonic fails to load.
  - `runCli`: on Windows the agent CLIs are `.cmd` shims, so it goes through the shell with manual quoting.
    Line breaks in arguments become spaces there, because cmd.exe ends a command at a line break.
  - Autostart: a launchd LaunchAgent, a Startup-folder `.vbs` script, or a `systemd --user` unit.
- **`src/bootstrap.mjs`**: durable installation for npx and native plugins. Runtime inputs are hashed and
  copied by npm (`--install-links`) into a staged prefix under `~/.claudespeak/runtime/`. Select the new
  runtime only after its package and inference dependency exist. Failed updates leave the previous selection.
  - ONNX Runtime is a dev dependency for checkout development; bootstrap explicitly installs it alongside
    the managed package with `ONNXRUNTIME_NODE_INSTALL=skip`. The initial npx/plugin download stays small.
  - Native hooks call `scripts/plugin.mjs`, which dispatches to the managed runtime. Hooks never install
    dependencies or download models. Explicit setup handles both. Direct hooks win over native hooks.
  - `scripts/build-plugins.mjs` generates manifests, marketplaces and plugin skills from `package.json` and
    `skill/SKILL.md`. Commit generated files; `--check` detects drift. Claude uses `.claude-plugin/`, Codex uses
    the portable root manifest's `com.openai` extension, and Copilot uses `com.github.copilot/hooks/`.
  - Codex lifecycle-hook plugins currently target manual desktop installs; CLI setup retains `notify`.
    `test/distribution.mjs` checks installation identity, failure recovery, cache independence and packaging.
- **`vendor/supertonic/helper.js`**: Supertone's MIT-licensed inference helper, vendored. Treat it as
  third-party code. The model weights are not in the repository.

Installed hooks and skills point at absolute paths in this checkout, so moving the repository breaks them until
`npm run setup` is run again.

## Adding an agent

An agent is supported once these pieces exist. Use the `claude`, `codex`, `copilot` and `opencode` paths in
each file as the template. Add the agent's name to `AGENTS` and its config folder to `config.mjs`:

1. **Turn-end trigger:** the agent runs `node src/hook.mjs --agent <name> --claudespeak` when a turn ends (or a
   plugin of the agent's pipes the message to it, as opencode's does). Pass `--detach` if the agent waits for
   the hook.
   `readEvent()` in `hook.mjs` must parse that agent's event format into `{ text, cwd }`.
2. **Summariser:** add a branch in `summarize()` that runs the agent's own CLI non-interactively, with no
   tools, read-only and no saved session, with `CLAUDESPEAK_CHILD=1` in its environment. `model auto` picks
   the agent that finished, and the `model` command in `cli.mjs` needs any new options.
3. **Install and uninstall:** add these to `install.mjs`. Merge into the agent's config instead of overwriting
   it, tag the entry with `MARK`, back the file up first, and restore whatever was there before on uninstall.
   Detect the agent by its config folder, add a `--<name>` flag, and honour an environment override for that
   folder so the smoke test can isolate it.
4. **Skill or command:** put `skill/SKILL.md` where the agent looks for skills or commands, with that agent's
   frontmatter.
5. **Smoke test:** in `test/smoke.mjs`, cover install twice, keeping the user's settings, the hook with
   `--print`, and uninstall restoring everything.
6. **Docs:** update the README's install table and the "What gets added" table.

Keep OS differences such as paths, shells, `.cmd` shims and players in `platform.mjs`. The only existing
exception is `systemLang()` in `config.mjs`.

## Conventions

- Match the existing style. Code is dense, with short one-line helpers, `/** … */` comments on what a function
  returns or does, and no new dependencies.
- The README documents every user-facing command and setting. When you add or change a command, update the
  README table, `skill/SKILL.md` and `HELP` in `cli.mjs` together.
