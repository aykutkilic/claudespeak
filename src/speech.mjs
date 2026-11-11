// Phrase-sized synthesis with one chunk of lookahead. Playback and inference overlap, but inference
// stays serial: the same ONNX sessions serve every recap. Cancellation also owns prefetched audio.
const STALE_MS = 3 * 60_000;
const FIRST_CHARS = 60;
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Ph\.D|etc|e\.g|i\.e|vs|Inc|Ltd|Co|Corp|St|Ave|Blvd)\.|\b[A-Z]\.)$/u;

function chunkLimit(lang) { return lang === "ja" || lang === "ko" ? 120 : 300; }

/** A short natural phrase, followed by the untouched remainder. Never wait for a full sentence. */
export function takeChunk(text, lang = "en", target = FIRST_CHARS) {
  text = text.trim();
  const limit = chunkLimit(lang);
  target = Math.min(limit, target);
  const max = Math.min(limit, Math.ceil(target * 1.5));
  if (text.length <= Math.min(limit, target + 20)) return [text, ""];
  const min = Math.min(40, target * 0.4), candidates = [];
  const add = (end, penalty) => {
    if (end < min || end > max || (text.length - end > 0 && text.slice(end).trim().length < min)) return;
    if (ABBREVIATION.test(text.slice(0, end))) return;
    candidates.push({ end, score: Math.abs(end - target) + penalty });
  };
  const locale = lang === "na" ? "en" : lang;
  // A bounded window avoids scanning a long recap again for every chunk. Its artificial end is ignored.
  const window = text.slice(0, max + 80);
  for (const s of new Intl.Segmenter(locale, { granularity: "sentence" }).segment(window)) {
    const end = s.index + s.segment.trimEnd().length;
    if (end < window.length || window.length === text.length) add(end, 0);
  }
  for (const m of window.matchAll(/[,;:，、；،؛—–](?:["'”’)]*)(?=\s|\p{L})/gu)) add(m.index + m[0].length, 15);
  for (const s of new Intl.Segmenter(locale, { granularity: "word" }).segment(window)) {
    if (!s.isWordLike) continue;
    let end = s.index + s.segment.length;
    while (/[.!?…。！？؟,;:，、；،؛"'”’)\]]/u.test(text[end] || "\0")) end++;
    add(end, 80);
  }
  candidates.sort((a, b) => a.score - b.score || a.end - b.end);
  let end = candidates[0]?.end ?? max;
  // An unbroken token can exceed the budget; do not cut a UTF-16 surrogate pair in half.
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return [text.slice(0, end).trimEnd(), text.slice(end).trimStart()];
}

/** Serial recap queue with adaptive chunk sizes and bounded audio buffering. */
export class SpeechQueue {
  constructor({ synthesize, play, dispose, acquire = async () => true, release = () => {}, onError = console.error,
    now = () => performance.now(), gap = 350, stale = STALE_MS }) {
    Object.assign(this, { synthesize, play, dispose, acquire, release, onError, now, gap, stale });
    this.items = [];
    this.current = null;
    this.running = null;
    this.synthesis = Promise.resolve();
  }

  get pending() { return this.items.length; }

  enqueue(message) {
    if (!message.text.trim()) return;
    this.items.push({ ...message, remaining: message.text.trim(), first: true, target: FIRST_CHARS,
      at: this.now(), controller: new AbortController(), prepared: null });
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = Promise.resolve().then(() => this.pump()).catch(this.onError).finally(() => {
      this.running = null;
      if (this.items.length) this.start();
    });
  }

  skip() { this.current?.controller.abort(); }
  stop() {
    this.skip();
    for (const item of this.items.splice(0)) this.discard(item);
  }

  /** Waits for playback, in-flight inference, and the disposal of cancelled prefetches. */
  async idle() {
    while (this.running) await this.running;
    await this.synthesis;
  }

  clean(audio) { if (audio) try { this.dispose(audio); } catch (e) { this.onError(e); } }
  discard(item) {
    item.controller.abort();
    if (item.prepared) item.prepared.promise.then((audio) => this.clean(audio));
    item.prepared = null;
  }

  prepare(item) {
    if (item.prepared) return item.prepared;
    if (item.controller.signal.aborted || !item.remaining) return null;
    const [text, remaining] = takeChunk(item.remaining, item.lang, item.target);
    const chunk = { ...item, text, first: item.first, last: !remaining };
    item.remaining = remaining;
    item.first = false;
    const promise = this.synthesis.then(async () => {
      if (item.controller.signal.aborted) return null;
      const start = this.now();
      const audio = await this.synthesize(chunk);
      const elapsed = Math.max(1, this.now() - start);
      // Aim to finish the next chunk within the audio already available, leaving a little headroom.
      // Larger chunks amortise inference overhead on fast machines; slower ones stay responsive.
      item.target = audio?.duration ? Math.max(40, Math.min(chunkLimit(item.lang),
        Math.floor(text.length * Math.max(0, audio.duration * 1000 - 150) / elapsed * 0.9))) : chunkLimit(item.lang);
      return audio;
    }).catch((e) => { this.onError(e); return null; });
    this.synthesis = promise.then(() => {});
    return (item.prepared = { chunk, promise });
  }

  async pump() {
    while (this.items.length) {
      const item = this.items.shift(), signal = item.controller.signal;
      this.current = item;
      let held = false, cancelled = false;
      try {
        if (this.now() - item.at > this.stale) continue;
        while (!signal.aborted && (item.prepared || item.remaining)) {
          const prepared = this.prepare(item);
          item.prepared = null;
          const audio = await prepared.promise;
          try {
            if (signal.aborted) break;
            if (!held) held = await this.acquire(signal);
            if (!held || signal.aborted) break;
            if (item.remaining) this.prepare(item);
            else {
              while (this.items.length && this.now() - this.items[0].at > this.stale) this.discard(this.items.shift());
              if (this.items[0]) this.prepare(this.items[0]);
            }
            await this.play(audio, prepared.chunk, signal);
          } finally { this.clean(audio); }
        }
      } catch (e) { this.onError(e); }
      finally {
        cancelled = signal.aborted;
        this.discard(item);
        if (held) this.release();
        this.current = null;
      }
      if (!cancelled && this.gap) await new Promise((r) => setTimeout(r, this.gap));
    }
  }
}
