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
