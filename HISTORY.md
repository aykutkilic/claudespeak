# Development History

## 2026-11-11

- Added `AGENTS.md` to describe contributor workflows, repository structure, checks, and development records.
- Replaced whole-recap synthesis with progressive phrase playback to reduce the wait for the first audio.
  The first chunk targets a short natural phrase rather than a fixed sentence count. Later chunk budgets
  adapt to measured inference time and audio duration, bounded by the model helper's 300-character limit
  (120 for Japanese/Korean). Summary generation still completes before synthesis starts.
- Separated scheduling (`src/speech.mjs`) and stateful audio processing (`src/audio.mjs`) from the HTTP server.
  One future chunk is buffered, ONNX calls stay serial, and voice/settings plus the playback lock belong to
  the whole recap. Compressor and reverb state continue between chunks; chimes frame the recap once.
- Made skip/stop cancel pending chunks as well as the player. ONNX calls cannot be interrupted, so late
  results are discarded and their WAVs removed. Engine loading is shared to avoid duplicate cold starts.
- Added deterministic tests for overlap, adaptive sizing, bounded buffering, FIFO, cancellation during
  inference/playback/lock acquisition, stale prefetched audio, fallback, cleanup, and DSP continuity. The
  optional model smoke check now exercises progressive synthesis too.
- Boundary inspection showed that `Intl.Segmenter` can separate `Dr.` from the following name; the chunk
  selector protects common abbreviations and initials. Clause boundaries can give useful first audio before
  a long sentence ends. Word boundaries remain a fallback for text without punctuation.
- Verified real Supertonic inference and native macOS `afplay` output. A warm comparison on the same
  290-character recap (M5, six steps) produced the first chunk in 902 ms versus 3,678 ms for the old full
  call; total chunk synthesis was 4,811 ms. This is one local measurement, excluding model load and summary
  generation; inference time varied substantially between runs. Native playback confirmed that a future
  WAV was ready before the first player finished and that generated WAVs were removed. macOS creates other
  temporary metadata, so cleanup checks must target the application's WAVs rather than the entire directory.
- Added native Claude Code, Codex desktop and Copilot CLI plugin metadata, setup/speak skills, and a
  one-command npx setup route for all supported agents. Consulted the official plugin documentation:
  OpenAI limits documented hook-plugin installation to manual desktop installs, so Codex CLI keeps `notify`.
- Added a staged, content-addressed shared runtime under `~/.claudespeak/runtime/`. This avoids hooks pointing
  into disposable npm/plugin caches and keeps a failed update from replacing a working installation. Native
  dependencies install only during explicit setup, with CUDA downloads disabled; models remain shared.
  Direct hooks take precedence over native hooks to avoid duplicate speech during migration.
- Generate plugin metadata and skills from package metadata and the existing command template, with a drift
  check in the test suite. Sandbox protections required scoped escalation for project `.agents/` marketplace
  metadata and the native validators; registry-free lockfile updates worked with npm's offline mode.
- Passed the real tarball/npx setup check for all four direct integrations, removed its npm cache, and
  verified the retained runtime plus uninstall restoration of an existing Codex notifier. The initial
  tarball was approximately 47 KB (30 files); native dependencies and models are installed separately.
  Added `npm run test:install` as a repeatable opt-in network check and a CI gate on all three platforms.
- Claude Code 2.1.322 accepted the plugin/marketplace manifest. Copilot CLI 1.0.109 installed the packaged
  plugin and discovered both skills in an isolated profile. Authenticated end-of-turn behavior in Copilot
  and Codex desktop remains a client-session check; installation validation alone does not establish it.
- Packaging checks can write npm cache data even in dry-run mode. Keep them outside the default offline
  suite. A test fixture initially overwrote the config's saved notifier; preserving that config while
  changing summary settings fixed the fixture and confirmed uninstall restoration.
- The packaged runtime also loaded its native inference helper after the npm cache was removed. Reloaded
  the local voice server after verification so the streaming code is active. Copilot's current CLI is a
  compiled distribution; a search confined to JavaScript files did not establish its hook environment
  variables and must not be interpreted as proof of missing support.
- Release v0.2.0 packages progressive speech and native plugins with a downloadable installer and
  versioned GitHub installation. Release checks cover the real model, package cache independence,
  configuration restoration, and the generated plugin manifests.
- Release CI passed synthesis on all platforms, but Windows converted generated files to CRLF and failed
  the exact-content drift check. Added `.gitattributes` to keep text checkouts at LF across platforms,
  preserving deterministic generated manifests and runtime identities without weakening the drift check.
