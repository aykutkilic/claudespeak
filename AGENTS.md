# Repository Guidelines

## Project Structure & Module Organization

claudespeak provides spoken summaries for coding agents using local Supertonic inference. `bin/claudespeak.mjs` launches the CLI. `src/` contains CLI commands, hooks, configuration, installation, text processing, the voice server, and platform adapters. Keep OS-specific behavior in `src/platform.mjs`.

`test/smoke.mjs` covers integration behavior. `skill/SKILL.md` is the installed command template; `vendor/supertonic/` contains third-party inference code and its license. Model weights download to `~/.claudespeak/models`, outside the repository. See `CLAUDE.md` for detailed architecture.

## Build, Test, and Development Commands

Use Node.js 20 or newer; CI uses Node.js 22. There is no build step.

- `npm install`: install dependencies; `.npmrc` skips the CUDA download.
- `npm test`: run the isolated smoke test without model downloads.
- `node bin/claudespeak.mjs install --models-only`: download approximately 410 MB of models.
- `SMOKE_TTS=1 npm test`: additionally verify synthesis; requires downloaded models. In PowerShell, set `$env:SMOKE_TTS="1"` first.
- `npm run setup`: install models and wire detected agents into this checkout.
- `node bin/claudespeak.mjs restart`: restart after server or imported-module changes.

## Coding Style & Naming Conventions

Use plain JavaScript ESM, two-space indentation, double quotes, semicolons, camelCase functions, and uppercase constants. Follow existing `.mjs` naming; preserve the `.js` plugin template required by opencode. No formatter or linter is configured. Prefer clear module boundaries and durable solutions; avoid new dependencies. Update `README.md`, `skill/SKILL.md`, and CLI `HELP` together for command changes.

## Testing Guidelines

Tests use `node:assert/strict`, without a test-runner framework or numeric coverage threshold. Extend `test/smoke.mjs` with descriptive scenario comments. Preserve temporary-home isolation. Cover repeated installation, existing settings, hook output, and uninstall restoration for agent changes. CI runs synthesis checks on all three supported operating systems.

## Commit & Pull Request Guidelines

History favors short, descriptive subjects such as `Add GitHub Copilot CLI and opencode support`; no strict prefix scheme is established. Keep commits focused. PRs should explain behavior, purpose, affected agents/platforms, linked issues when applicable, and validation results. Include playback evidence for audio changes.

## Architecture & Development Records

Set `CLAUDESPEAK_CHILD=1` on summarizer subprocesses to prevent recursion. Preserve configuration backups and existing user settings during installation.

Record dated changes, their purpose, architectural decisions, and useful lessons from failures or disagreements in repository documentation.

- 2026-11-11: Added this contributor guide to document repository workflows and maintenance expectations.
