import fs from "node:fs";

// Stateful DSP: chunk boundaries do not reset the compressor or room, or add extra chimes/tails.
// ---- Effects: light compressor → the project's chimes around the voice → small room reverb → peak ceiling.
export function createEffects(sr, fx, chimes, project) {
  const compressor = makeCompressor(sr, fx.compressor);
  const room = makeReverb(sr, fx.reverb);
  return (x, { first = true, last = true } = {}) => {
    if (fx.compressor?.enabled !== false) x = compressor(x);
    if (chimes.enabled) x = withChimes(x, sr, project, chimes, first, last);
    if (fx.reverb?.enabled !== false) x = room(x, last);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    const ceil = 10 ** ((fx.peak ?? -1) / 20);
    if (peak > ceil) for (let i = 0; i < x.length; i++) x[i] *= ceil / peak;
    return x;
  };
}

/** Feed-forward peak compressor with a smoothed envelope; gentle by default (2:1 over −20 dB). */
function makeCompressor(sr, { threshold, ratio, attack, release, makeup }) {
  const a = Math.exp(-1 / (attack * sr)), r = Math.exp(-1 / (release * sr));
  const make = 10 ** (makeup / 20);
  let env = 0;
  return (x) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      env = v > env ? a * env + (1 - a) * v : r * env + (1 - r) * v;
      const over = 20 * Math.log10(env + 1e-9) - threshold;
      out[i] = x[i] * (over > 0 ? 10 ** ((-over * (1 - 1 / ratio)) / 20) : 1) * make;
    }
    return out;
  };
}

/** Mono Freeverb (8 damped combs → 4 allpasses) under the dry voice, with a tail to ring out. */
function makeReverb(sr, { room, damp, wet, tail }) {
  const k = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((l) => ({ buf: new Float32Array(Math.round(l * k)), i: 0, store: 0 }));
  const alls = [556, 441, 341, 225].map((l) => ({ buf: new Float32Array(Math.round(l * k)), i: 0 }));
  const fb = room * 0.28 + 0.7, d = damp * 0.4;
  return (x, last) => {
    const n = x.length + (last ? Math.floor(tail * sr) : 0), out = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      const dry = t < x.length ? x[t] : 0, inp = dry * 0.015;
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.store = y * (1 - d) + c.store * d;
        c.buf[c.i] = inp + c.store * fb;
        if (++c.i >= c.buf.length) c.i = 0;
        acc += y;
      }
      for (const ap of alls) {
        const b = ap.buf[ap.i];
        ap.buf[ap.i] = acc + b * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0;
        acc = b - acc;
      }
      out[t] = dry + acc * wet * 3;
    }
    return out;
  };
}

// ---- Chimes: a faint two-note signature per project, from its name (and its reroll seed).
const TIMBRES = {
  sine: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.08 * Math.sin(4 * Math.PI * f * t),
  bell: (f, t) => Math.sin(2 * Math.PI * f * t + 1.1 * Math.exp(-t / 0.07) * Math.sin(2 * Math.PI * 3.5 * f * t)),
  glass: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.3 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 2.76 * f * t),
  marimba: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.3 * Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * 4 * f * t),
  pluck: (f, t) => Math.sin(2 * Math.PI * f * t) + 0.35 * Math.exp(-t / 0.02) * Math.sin(2 * Math.PI * 3 * f * t),
};
const PENTA = [0, 2, 4, 7, 9], INTERVALS = [4, 5, 7, 9];
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Timbre, root (C5–D6 pentatonic, top note under ~2 kHz), interval, spacing and decay. */
function chimeSpec(key, settings) {
  const r = rng(hash(key + ":" + (settings.seeds[key] ?? 0)));
  const names = Object.keys(TIMBRES), step = Math.floor(r() * 7);
  return {
    timbre: names[Math.floor(r() * names.length)],
    root: 523.25 * 2 ** ((12 * Math.floor(step / 5) + PENTA[step % 5]) / 12),
    ratio: 2 ** (INTERVALS[Math.floor(r() * INTERVALS.length)] / 12),
    gap: 0.06 + r() * 0.04, tau: 0.07 + r() * 0.05,
  };
}
function chime(sr, spec, notes, gap, tau) {
  const len = Math.ceil((gap * (notes.length - 1) + tau * 6) * sr), out = new Float32Array(len), wave = TIMBRES[spec.timbre];
  notes.forEach((f, k) => {
    const at = Math.floor(k * gap * sr), g = k ? 0.8 : 1;
    for (let i = 0; at + i < len; i++) {
      const t = i / sr, env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
      if (env < 1e-4 && t > 0.01) break;
      out[at + i] += g * env * wave(f, t);
    }
  });
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < len; i++) out[i] /= peak || 1;
  return out;
}
/** A rising chime, the voice coming in as it fades, and a falling chime after the last word. */
function withChimes(x, sr, key, settings, first, last) {
  if (!first && !last) return x;
  const s = chimeSpec(key, settings), top = s.root * s.ratio;
  const intro = first ? chime(sr, s, [s.root, top], s.gap, s.tau) : [];
  const outro = last ? chime(sr, s, [top, s.root * 0.75], s.gap * 1.3, s.tau * 1.4) : [];
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = (peak || 0.3) * 10 ** (settings.volume / 20);
  const vAt = first ? Math.floor((s.gap + 2.2 * s.tau) * sr) : 0;
  const oAt = vAt + x.length + (last ? Math.floor(0.1 * sr) : 0);
  const out = new Float32Array(Math.max(intro.length, vAt + x.length, oAt + outro.length));
  for (let i = 0; i < intro.length; i++) out[i] += intro[i] * g;
  for (let i = 0; i < x.length; i++) out[vAt + i] += x[i];
  for (let i = 0; i < outro.length; i++) out[oAt + i] += outro[i] * g;
  return out;
}

export function writeWav(file, s, rate) {
  const n = s.length, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i] || 0)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
