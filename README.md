# claudespeak

Spoken summaries for **Claude Code**, **Codex**, **GitHub Copilot CLI** and **opencode**. When an agent finishes a turn, you hear one or two
sentences about what it did, in a natural local voice. You can keep working in another window and
still know when something is done or waiting for you.

- **Local voice.** [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3) runs on your CPU
  through ONNX Runtime. It speaks 31 languages, comes with 10 voices, and runs faster than real time. No audio
  leaves your machine.
- **Real summaries.** The agent's own CLI writes the summary (`claude -p`, Sonnet by default, `codex exec`,
  `copilot -p` or `opencode run`), in your language, with numbers spelled out and no code or file paths read aloud.
- **Foreign terms said right.** In a language other than English, the summariser respells product names,
  English terms and acronyms the way they sound, in that language's letters. In Turkish, for example, macOS
  becomes "mekos", MIT "em ay ti" and GitHub "githab", so a Turkish voice doesn't read them letter by letter as
  Turkish. When it gets a term wrong, `pronounce` fixes it for good.
- **One voice per project.** Every project, named after its git root folder, gets its own voice and a faint
  two-note chime: rising before the summary, falling after. With three agents running in three repos, you can
  tell who is talking.
- **One speaker at a time.** Everything goes through a single queue, and a machine-wide lock keeps voices from
  overlapping, even across processes.
- **Earlier playback.** Once the summary text arrives, a short phrase plays while the next chunk is synthesised.
  Chunk sizes adapt to measured inference speed, with sentence and clause boundaries preferred.
- **Light mastering.** A gentle compressor and a small room reverb are applied. You can tune both or turn them off.
- **`/speak`** in Claude Code, Copilot CLI and opencode, and **`$speak`** in Codex, change any setting in plain words:
  "make the reverb a bit lighter", "speak German in this repo", "voice M2 for my-api".

Runs on macOS, Windows and Linux.

## Install

You need Node.js 20 or newer, `git`, and a supported coding agent. Allow space for the approximately 410 MB
voice model plus the platform's inference runtime.
Choose the plugin for your agent, or use the one-command installer.

### Claude Code plugin

In Claude Code:

```text
/plugin install claudespeak --marketplace aykutkilic/claudespeak
/claudespeak:setup
```

The plugin supplies the turn-end hook and `/claudespeak:speak` for settings. Older Claude Code versions can
use `/plugin marketplace add aykutkilic/claudespeak`, then `/plugin install claudespeak@claudespeak`.

### GitHub Copilot CLI plugin

```sh
copilot plugin install aykutkilic/claudespeak
```

Restart Copilot, then ask it to run the claudespeak **setup** skill. Use its **speak** skill to configure speech.
The plugin supplies the `agentStop` hook; no hand-edited configuration is needed.

### Codex desktop plugin

```sh
codex plugin marketplace add aykutkilic/claudespeak
```

Open the Plugins Directory in the desktop app, select the **claudespeak** marketplace, and install the plugin.
Review its hooks when Codex prompts, then ask it to run the claudespeak **setup** skill.
OpenAI currently documents lifecycle-hook plugins for manual desktop installation; for Codex CLI, use the
installer below, which configures `notify` and `$speak`.
([OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks))

### One command for all agents

```sh
npx --yes github:aykutkilic/claudespeak setup
```

This detects Claude Code, Codex, Copilot CLI and opencode. To select one, append `--codex`, `--claude`,
`--copilot` or `--opencode`. No manual clone or global npm installation is needed. The runtime is copied into
`~/.claudespeak/runtime/`, so clearing the npm or plugin cache does not break installed hooks.

Restart the configured agent, then run `/speak test` (`$speak test` in Codex) to hear a sample. Use
`/speak status`, `/speak lang tr`, or `/speak off` to inspect settings, select Turkish, or mute summaries;
Codex uses the same commands after `$speak`. The Claude Code plugin uses `/claudespeak:speak` instead.

Setup downloads the approximately 410 MB voice model once. Plugins share this model and runtime across agents.
Installing a plugin alone does not download the model: run its setup skill once, and again after updating the
plugin to update the runtime. Existing direct hooks take precedence over plugin hooks to prevent duplicate speech.
Remove native plugins through their agent's plugin manager; the shared runtime stays available to other agents.

### Development checkout

```sh
git clone https://github.com/aykutkilic/claudespeak
cd claudespeak
npm install
npm run setup
```

`npm run setup` downloads the voice model once (about 410 MB, from Hugging Face). It then wires up every agent
it finds:

| | What gets added | Where |
|---|---|---|
| Claude Code | an async `Stop` hook and the `/speak` skill | `~/.claude/settings.json`, `~/.claude/skills/speak/` |
| Codex | `notify` and the `$speak` skill | `~/.codex/config.toml`, `~/.agents/skills/speak/` |
| Copilot CLI | an `agentStop` hook and the `/speak` skill | `~/.copilot/hooks/claudespeak.json`, `~/.copilot/skills/speak/` |
| opencode | a plugin and the `/speak` command | `~/.config/opencode/plugins/claudespeak.js`, `~/.config/opencode/commands/speak.md` |

Existing settings are merged, and a backup is saved next to each file as `*.claudespeak-backup`. If Codex
already had a `notify` command, it keeps running: claudespeak calls it after itself. Copilot CLI and opencode get
files of their own, next to yours. `COPILOT_HOME`, `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` are honoured. To set
up only some agents, pass any of `--claude`, `--codex`, `--copilot` and `--opencode`. Restart open sessions
afterwards (for opencode 2.x, `opencode reload`), then try it:

```sh
node bin/claudespeak.mjs test
```

For development-checkout installs, keep the clone where it is: its hooks run from it. Update with
`git pull && npm install && npm run setup`. For managed installs, rerun the one-command installer or the plugin's
setup skill. User settings and the downloaded model are preserved.

Run `npm test` for isolated integration and streaming checks; `SMOKE_TTS=1 npm test` also exercises the real
model. `npm run test:install` verifies the packaged npx installer in a temporary home, including deleting its
cache and restoring existing settings on uninstall. It needs registry access, but does not download voice models.

### Per OS

- **macOS.** Audio plays through `afplay`. Nothing else is needed.
- **Windows.** Audio plays through PowerShell's `System.Media.SoundPlayer`. Nothing else is needed. Run the
  commands above in PowerShell or Git Bash.
- **Linux.** Audio plays through the first of `pw-play` (PipeWire), `paplay` (PulseAudio), `aplay` (ALSA) or
  `ffplay` that it finds. Most desktops have one; otherwise install `pipewire`, `pulseaudio-utils` or
  `alsa-utils`. ONNX Runtime ships CPU builds for x64 and arm64.

The voice server starts by itself with the first summary. To have it start at login, so the first summary
comes without the model's load delay, run `claudespeak autostart on`. This uses a LaunchAgent on macOS, a
hidden Startup-folder script on Windows, and a `systemd --user` unit on Linux.

## Use

In Claude Code, Copilot CLI and opencode, type `/speak …`. In Codex, type `$speak …`. All accept the commands below
or plain words.
From a terminal, run `node bin/claudespeak.mjs …`, or `npm link` once and then just `claudespeak …`.

| Command | Does |
|---|---|
| `setup [--claude\|--codex\|--copilot\|--opencode]` | install/update the durable runtime and detected agents |
| `status`, `doctor` | show all settings / check the setup |
| `on`, `off`, *(nothing)* | turn speech on, off, or toggle it |
| `voices` | list the 10 voices, F1–F5 and M1–M5, with what each sounds like |
| `voice M2 [project]` | set a project's voice (default: the current project) |
| `rotation F5 M2 M5` | set the voices new projects take, in turn |
| `lang de [project]`, `lang reset [project]` | set the summary language, globally or per project (`na` = the message's own language) |
| `model sonnet` / `haiku` / `opus` | choose the Claude model that writes the summary |
| `model codex-model <name>` | choose the Codex model that writes the summary |
| `model copilot-model <name>`, `model opencode-model <provider/model>` | choose the Copilot CLI or opencode model that writes the summary |
| `model auto` / `claude` / `codex` / `copilot` / `opencode` / `none` | choose who summarises (`none` = read the first sentence) |
| `steps 8`, `speed 1.1` | set synthesis quality (default 6) and speaking rate |
| `chime off`, `chime volume -20`, `chime reroll` | turn chimes off, set their level, or give a project a different chime |
| `reverb wet 0.15`, `reverb off` | adjust or turn off the reverb (also `room`, `damp`, `tail`) |
| `compressor ratio 3 threshold -18`, `compressor off` | adjust or turn off the compressor (also `attack`, `release`, `makeup`) |
| `pronounce GraphQL graf kyu el`, `unpronounce GraphQL`, `pronunciations` | fix how a term is read in a language (default: this project's) |
| `test [text]` | say a sample in this project's voice |
| `skip`, `stop`, `restart` | skip the current summary, clear the queue, or restart the server |
| `autostart on` / `off` | start the server at login |
| `reset`, `reset all` | restore the effect defaults / all defaults |

The language starts as your OS's display language: the first of macOS's preferred languages, Windows' UI
language, or `LC_ALL` / `LC_MESSAGES` / `LANG` on Linux. If Supertonic doesn't speak it, English is used.
Change it with `lang <code>`; `lang system` detects it again.

Settings live in `~/.claudespeak/config.json`. The server picks up changes immediately.

## How it works

```
agent turn ends ─▶ hook.mjs ─▶ claude -p / codex exec / copilot -p / opencode run writes 1–2 sentences
                                │
                                ▼
                     server.mjs (localhost:7841, started on demand)
                     queue ─▶ Supertonic 3 ─▶ compressor ─▶ chimes ─▶ reverb ─▶ play.lock ─▶ speaker
```

- The summariser runs with `CLAUDESPEAK_CHILD=1`, so its own turn never triggers another summary. Claude runs
  with `--safe-mode --tools ""`; Codex runs with `--ephemeral --sandbox read-only`; Copilot CLI runs with
  `-p --no-ask-user` and shell and write tools denied; opencode runs as its tool-less `summary` agent on 2.x
  (read-only `plan` on 1.x), and its session is deleted afterwards.
- Copilot CLI waits for its hooks, so the hook hands the event to a detached copy of itself and returns at once.
  It reads the message from the session's `events.jsonl`. The opencode plugin works with both 1.x and 2.x. It
  ignores subagent sessions and claudespeak's own summary sessions.
- Summaries more than 3 minutes old are dropped instead of being read late. Synthesis starts with a short
  phrase, then adapts chunk sizes to the time available during playback. Only one future chunk is buffered;
  inference stays serial. A recap keeps its voice, effects and playback lock across chunks, with one opening
  and closing chime. `skip` cancels the whole current recap; `stop` also clears queued recaps, including
  prefetched audio. The agent still finishes writing the summary before speech synthesis begins.

**Privacy:** the end-of-turn message is sent to the same provider your agent already uses, through its own
CLI, to write the summary. Synthesis and playback are local. `model none` sends nothing anywhere.

## Uninstall

```sh
node bin/claudespeak.mjs uninstall          # remove the hooks, plugin, skills and autostart; restore Codex's old notify
node bin/claudespeak.mjs uninstall --purge  # …and delete ~/.claudespeak (model and settings)
```

## Licenses

- claudespeak: [MIT](LICENSE), © 2026 Aykut Kilic.
- `vendor/supertonic/helper.js`: MIT, © 2025 Supertone Inc. ([LICENSE](vendor/supertonic/LICENSE)).
- The Supertonic 3 **model** is not part of this repository. The installer downloads it from Hugging Face,
  and it is licensed separately under **OpenRAIL-M**, which includes use restrictions. See its
  [model card](https://huggingface.co/supertone-oss-archive/supertonic-3) before using it.
- [ONNX Runtime](https://github.com/microsoft/onnxruntime): MIT.

claudespeak is an independent project and is not affiliated with Anthropic, OpenAI, GitHub, the opencode project
or Supertone.

Plugin formats follow the [Claude Code manifest reference](https://code.claude.com/docs/en/plugins-reference)
and [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
