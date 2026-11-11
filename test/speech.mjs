// Deterministic scheduling checks: no audio hardware, model download, or real home directories.
import assert from "node:assert/strict";
import { SpeechQueue, takeChunk } from "../src/speech.mjs";
import { createEffects } from "../src/audio.mjs";
import { DEFAULTS } from "../src/config.mjs";

const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const LONG = "The new voice pipeline starts with a short phrase, while the remaining audio is prepared in the background. " +
  "It keeps every project's recap together and preserves the voice and effects across chunk boundaries. ";
const unexpected = (e) => { throw e; };

// Natural boundaries, decimals, abbreviations, unpunctuated text, and scripts without spaces.
for (const [lang, text] of [["en", LONG.repeat(5)], ["tr", "Ses akışını geliştirdim, kalan ses hesaplanırken ilk kısmı dinleyebilirsiniz. ".repeat(8)],
  ["ja", "最初の部分を再生しながら残りの音声を計算します。自然な位置で区切ります。".repeat(12)],
  ["ko", "첫 부분을 재생하는 동안 나머지 음성을 준비합니다. ".repeat(12)], ["en", "word ".repeat(200)], ["en", "😀".repeat(200)]]) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining) {
    const [head, tail] = takeChunk(remaining, lang, chunks.length ? 300 : 100);
    assert.ok(head && tail.length < remaining.length, "every chunk makes progress");
    assert.ok(head.length <= (lang === "ja" || lang === "ko" ? 120 : 300), "bounded inference size");
    assert.ok(!/[\uD800-\uDBFF]$/u.test(head), "no broken surrogate pairs");
    chunks.push(head); remaining = tail;
  }
  assert.equal(chunks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""), "no lost or repeated text");
  assert.ok(chunks.length > 1);
}
assert.deepEqual(takeChunk("Done."), ["Done.", ""]);
const [natural] = takeChunk(LONG.repeat(3));
assert.match(natural, /[,.]$/, "prefer a sentence or clause over an arbitrary word boundary");
assert.ok(takeChunk("The new voice pipeline starts with a short phrase, " + "and more details follow without sentence punctuation ".repeat(8))[0].endsWith(","));
const [names] = takeChunk("Dr. Smith measured 3.5 milliseconds, then checked everything carefully without changing the configuration. ".repeat(3));
assert.ok(names.includes("Dr. Smith") && names.includes("3.5"));

// Playback starts before the remaining inference finishes. Exactly one future chunk is buffered.
{
  const firstPlaying = deferred(), finishFirst = deferred(), finishTail = deferred();
  const generated = [], played = [], disposed = [], locks = [];
  let inFlight = 0, outstanding = 0, maxOutstanding = 0;
  const q = new SpeechQueue({ gap: 0, onError: unexpected,
    synthesize: async (m) => {
      assert.equal(++inFlight, 1, "inference must stay serial");
      const id = generated.push(m) - 1;
      if (id) await finishTail.promise;
      inFlight--;
      maxOutstanding = Math.max(maxOutstanding, ++outstanding);
      return { id, duration: 10 };
    },
    play: async (audio, m) => {
      played.push(m);
      if (audio.id === 0) { firstPlaying.resolve(); await finishFirst.promise; }
    },
    dispose: (audio) => { outstanding--; disposed.push(audio.id); },
    acquire: async () => { locks.push("acquire"); return true; }, release: () => locks.push("release"),
  });
  q.enqueue({ text: LONG.repeat(5), project: "a", lang: "en" });
  q.enqueue({ text: "Another project.", project: "b", lang: "en" });
  await firstPlaying.promise;
  await tick();
  assert.equal(played.length, 1, "first audio plays while tail inference is blocked");
  assert.equal(generated.length, 2);
  finishTail.resolve(); await tick();
  assert.equal(generated.length, 2, "do not eagerly synthesize the whole recap");
  finishFirst.resolve(); await q.idle();
  assert.equal(played.at(-1).project, "b");
  assert.ok(played.slice(0, -1).every((m) => m.project === "a"), "recaps never interleave");
  assert.equal(played.filter((m) => m.project === "a" && m.first).length, 1);
  assert.equal(played.filter((m) => m.project === "a" && m.last).length, 1);
  assert.ok(generated[1].text.length > generated[0].text.length, "fast inference grows subsequent chunks");
  assert.equal(maxOutstanding, 2);
  assert.equal(outstanding, 0);
  assert.equal(new Set(disposed).size, generated.length, "dispose every WAV exactly once");
  assert.deepEqual(locks, ["acquire", "release", "acquire", "release"], "hold the lock across a whole recap");
}

// The continuation budget follows observed inference speed instead of a fixed sentence count.
{
  const sizes = async (inferenceMs) => {
    let time = 0;
    const lengths = [];
    const q = new SpeechQueue({ gap: 0, now: () => time, onError: unexpected,
      synthesize: async (m) => { lengths.push(m.text.length); time += inferenceMs; return { duration: 3 }; },
      play: async () => {}, dispose: () => {},
    });
    q.enqueue({ text: LONG.repeat(6) }); await q.idle(); return lengths;
  };
  const fast = await sizes(100), slow = await sizes(5000);
  assert.equal(fast[0], slow[0], "the first phrase never waits for throughput measurements");
  assert.ok(fast[1] > slow[1], "slow inference keeps later chunks small enough to stay responsive");
}

// Skip while the first inference is pending: it must never start playing afterwards.
{
  const started = deferred(), finish = deferred(), played = [], disposed = [];
  const q = new SpeechQueue({ gap: 0, onError: unexpected,
    synthesize: async (m) => { if (m.project === "skip") { started.resolve(); await finish.promise; } return { project: m.project }; },
    play: async (audio) => played.push(audio.project), dispose: (audio) => disposed.push(audio.project),
  });
  q.enqueue({ text: LONG.repeat(4), project: "skip" });
  q.enqueue({ text: "Keep this.", project: "keep" });
  await started.promise; q.skip(); finish.resolve(); await q.idle();
  assert.deepEqual(played, ["keep"]);
  assert.deepEqual(disposed, ["skip", "keep"]);
}

// Stop during playback and prefetch, then immediately enqueue again: no stale audio or concurrent ONNX.
{
  const playing = deferred(), prefetched = deferred(), finish = deferred();
  const played = [], disposed = [];
  let calls = 0, inFlight = 0;
  const q = new SpeechQueue({ gap: 0, onError: unexpected,
    synthesize: async (m) => {
      assert.equal(++inFlight, 1);
      const id = ++calls;
      if (id === 2) { prefetched.resolve(); await finish.promise; }
      inFlight--; return { id, project: m.project, duration: 10 };
    },
    play: async (audio, m, signal) => {
      played.push(audio.project);
      if (audio.id === 1) { playing.resolve(); await new Promise((r) => signal.addEventListener("abort", r, { once: true })); }
    }, dispose: (audio) => disposed.push(audio.id),
  });
  q.enqueue({ text: LONG.repeat(4), project: "stop" });
  q.enqueue({ text: "Drop this queued recap.", project: "drop" });
  await playing.promise; await prefetched.promise;
  q.stop(); q.enqueue({ text: "Fresh audio.", project: "fresh" }); finish.resolve(); await q.idle();
  assert.deepEqual(played, ["stop", "fresh"]);
  assert.deepEqual(disposed.sort(), [1, 2, 3]);
}

// Cancellation while waiting for another process's playback lock also disposes ready audio.
{
  const waiting = deferred(), disposed = [];
  const q = new SpeechQueue({ gap: 0, onError: unexpected,
    synthesize: async () => ({ id: 1 }), play: () => assert.fail("cancelled lock waiter played"),
    acquire: (signal) => { waiting.resolve(); return new Promise((r) => signal.addEventListener("abort", () => r(false), { once: true })); },
    release: () => assert.fail("released an unowned lock"), dispose: (audio) => disposed.push(audio.id),
  });
  q.enqueue({ text: "Waiting." }); await waiting.promise; q.skip(); await q.idle();
  assert.deepEqual(disposed, [1]);
}

// A queued recap can expire after prefetch: its WAV is removed rather than played.
{
  const playing = deferred(), finish = deferred(), played = [], disposed = [];
  let time = 0;
  const q = new SpeechQueue({ gap: 0, stale: 100, now: () => time, onError: unexpected,
    synthesize: async (m) => ({ project: m.project }), dispose: (audio) => disposed.push(audio.project),
    play: async (audio) => { played.push(audio.project); playing.resolve(); await finish.promise; },
  });
  q.enqueue({ text: "First.", project: "first" }); q.enqueue({ text: "Expired.", project: "old" });
  await playing.promise; await tick(); time = 200; finish.resolve(); await q.idle();
  assert.deepEqual(played, ["first"]); assert.deepEqual(disposed, ["first", "old"]);
}

// Synthesis errors fall back per phrase and do not strand the queue.
{
  const errors = [], played = [];
  const q = new SpeechQueue({ gap: 0, onError: (e) => errors.push(e.message),
    synthesize: async () => { throw new Error("engine unavailable"); },
    play: async (audio, m) => { assert.equal(audio, null); played.push(m.text); }, dispose: () => assert.fail(),
  });
  q.enqueue({ text: "Use the system voice." }); await q.idle();
  assert.deepEqual(errors, ["engine unavailable"]); assert.deepEqual(played, ["Use the system voice."]);
}

// Processing chunks produces the same compressor/reverb signal as processing one buffer.
{
  const sr = 24000, fx = structuredClone(DEFAULTS.fx), chimes = { ...DEFAULTS.chimes, enabled: false };
  const input = Float32Array.from({ length: sr }, (_, i) => 0.05 * Math.sin(i * 0.03));
  const whole = createEffects(sr, fx, chimes, "test")(input);
  const process = createEffects(sr, fx, chimes, "test");
  const chunks = [process(input.slice(0, 7000), { first: true, last: false }),
    process(input.slice(7000, 15000), { first: false, last: false }), process(input.slice(15000), { first: false, last: true })];
  assert.deepEqual(Float32Array.from(chunks.flatMap((c) => Array.from(c))), whole);
  const dry = { ...fx, compressor: { ...fx.compressor, enabled: false }, reverb: { ...fx.reverb, enabled: false } };
  const chimed = createEffects(sr, dry, DEFAULTS.chimes, "test");
  assert.ok(chimed(input, { first: true, last: false }).length > input.length);
  assert.deepEqual(chimed(input, { first: false, last: false }), input, "no chime or padding inside a recap");
  assert.ok(chimed(input, { first: false, last: true }).length > input.length);
}

console.log("speech streaming tests passed");
