---
name: speak
description: Configure claudespeak spoken summaries, voices, language, pronunciation, speed and audio effects.
---

Resolve `../../scripts/plugin.mjs` relative to this SKILL.md's directory to get the plugin entry point. Use its absolute path (quoted) in every command below. The plugin shares a durable runtime in `~/.claudespeak`; the working directory remains the user's project.

If setup is missing, explain that the setup skill installs the runtime and voice model, and run it when requested.

Turn the request into one or more calls of `node "<absolute plugin entry point>" <command>` (quote every argument) and run them in the
shell. No request means `toggle`. Commands:

| Command | Does |
|---|---|
| `setup` | install or update the shared voice runtime and local model |
| `toggle` / `on` / `off` | spoken summaries on/off |
| `status` | everything: on/off, server, this project's voice and language, all projects, model, quality, fx |
| `voices` | the 10 voices: F1–F5 (female), M1–M5 (male), with what each sounds like |
| `voice <V> [project\|.]` | a project's voice (project = git root folder name; `.` or nothing = this one) |
| `rotation <V> <V> …` | voices new projects take in turn |
| `lang <code> [project\|.]` / `lang reset [project\|.]` | summary language, global or per project: en tr de fr es it pt nl ru uk pl cs sk sl hr bg ro hu el fi et lv lt sv da ar hi id vi ja ko, `na` = the message's own language |
| `model haiku\|sonnet\|opus` | Claude model that writes the summary |
| `model codex-model <name>` / `model copilot-model <name>` / `model opencode-model <provider/model>` | the Codex, Copilot CLI or opencode model that writes the summary (empty = that agent's default) |
| `model auto\|claude\|codex\|copilot\|opencode\|none` | who summarises: the agent that finished, always one of them, or nobody (first sentence) |
| `steps <1–20>` | quality (denoising steps; more = better, slower; default 6) |
| `speed <0.7–1.6>` | speaking rate (default 1.05) |
| `chime [on\|off]` / `chime volume <-40–-3>` / `chime reroll [project\|.]` | the faint per-project chime (rising before, falling after); volume is dB under the voice; reroll picks another |
| `compressor [on\|off] [threshold dB] [ratio N] [attack s] [release s] [makeup dB]` | e.g. `compressor ratio 3 threshold -18` |
| `reverb [on\|off] [room 0–1] [damp 0–1] [wet 0–1] [tail s]` | e.g. `reverb wet 0.3`; `wet` is how much of it you hear |
| `pronounce <term> <how to say it…> [--lang xx]` | fix how a term is read, e.g. `pronounce GraphQL graf kyu el` (language: this project's) |
| `unpronounce <term>` / `pronunciations` | drop a fix / list them |
| `peak <-12–0>` | output ceiling, dBFS |
| `reset` / `reset all` | effects back to defaults / every setting (project voices, languages, chimes kept) |
| `test [text]` | say a sample in this project's voice, with the current settings |
| `skip` / `stop` / `restart` | skip the summary being read / clear the queue / restart the server |
| `autostart on\|off\|status` | start the voice server at login |
| `doctor` | check the setup |

If the user says a word is read wrong ("it says macos, it should be mekos"), that is `pronounce`, with the
spelling they give or, if they only describe the sound, your best respelling in that language's letters.
Plain-word requests map onto these: "a bit" means a small step from the current value (run `status` first),
e.g. "make the reverb a bit lighter" → `reverb wet` about 0.05–0.08 lower; "better quality" → `steps` +2.
After a change to voice, language, speed, steps, chimes or fx, run `test` too, so it can be heard.

Reply in the user's language with only the resulting state, in one or two short lines (for `status`,
`voices` and `doctor`, the tool's lines as they are). No other commentary.
