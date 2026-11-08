// Text helpers for the hook: the last assistant message of a Claude Code transcript, and the plain
// fallback recap (first sentence, markdown and code out, numbers as English words) used when no model
// writes the summary.
import fs from "node:fs";

const MAX_CHARS = 2500;
const RECAP_CHARS = 160;
const UNITS = { ms: "milliseconds", "µs": "microseconds", km: "kilometres", cm: "centimetres", mm: "millimetres", kB: "kilobytes", KB: "kilobytes", MB: "megabytes", GB: "gigabytes", m: "metres", s: "seconds", px: "pixels", "°": "degrees" };
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** The text of the transcript's last assistant message (its blocks share one message id). */
export function lastMessage(file) {
  if (!file || !fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  let id = null, parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type === "user" && !d.isMeta && id) break;
    if (d.type !== "assistant" || d.isSidechain) continue;
    const m = d.message;
    if (id && m.id !== id) break;
    const texts = (m.content || []).filter((c) => c.type === "text").map((c) => c.text);
    if (!texts.length) continue;
    id = m.id;
    parts.unshift(...texts);
  }
  return parts.join("\n\n");
}

/** The spoken part: the first prose paragraph's first sentence, asides in brackets left out. */
export function recap(s) {
  const paras = s.replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/).map((p) => p.trim())
    .filter((p) => p && !/^(#|\||```)/.test(p));
  let p = (paras[0] || "").split("\n")[0].replace(/^\s*([-*+]|\d+\.)\s+/, "");
  p = p.replace(/\s*\([^()]*\)/g, "");                                    // (asides)
  p = p.replace(/https?:\/\/\S+?(?=[.,;:)]?(\s|$))/g, "");
  const sentences = p.split(/(?<=[.!?])\s+/);                               // a "." inside file.js or 3.5 doesn't end one
  let out = sentences.slice(0, 1).join(" ").trim();
  if (out.length > RECAP_CHARS) out = out.slice(0, out.lastIndexOf(" ", RECAP_CHARS)) + "…";
  return out;
}

/** Markdown and code out, numbers and symbols written as words (the fallback when no model writes a summary). */
export function sayable(s) {
  s = s.replace(/```[\s\S]*?```/g, " ")                       // code blocks
    .replace(/^\s*\|.*\|\s*$/gm, " ")                          // table rows
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")                     // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")                   // links → their text
    .replace(/https?:\/\/\S+?(?=[.,;:)]?(\s|$))/g, " ")
    .replace(/`([^`]+)`/g, (_, c) => codeWords(c))
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*(\d+)\.\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/^>\s?/gm, "")
    .replace(/\b[0-9a-f]{7,40}\b/g, (h) => (/\d/.test(h) && /[a-f]/.test(h) ? " " : h));
  s = s.replace(/(\S+\/)+(\S+?\.\w+)(:\d+)?/g, (_, _d, f) => fileWords(f))   // paths → file name
    .replace(/\b[\w-]+\.(m?js|ts|json|md|html|css|py|sh|gz)\b(:\d+)?/g, (f) => fileWords(f));
  s = s.replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2")
    .replace(/(\d)\s*[×x]\s*(?=\d|\b)/g, "$1 times ")
    .replace(/→|->/g, " to ").replace(/←/g, " from ").replace(/≈|~(?=\d)/g, " about ")
    .replace(/≤/g, " at most ").replace(/≥/g, " at least ").replace(/±/g, " plus or minus ")
    .replace(/&/g, " and ").replace(/\s[-–—]\s/g, ", ")
    .replace(/(\d)%/g, "$1 percent").replace(/\$(\d[\d,.]*)/g, "$1 dollars")
    .replace(/(\d+(?:\.\d+)?)\s?(ms|µs|km|cm|mm|kB|KB|MB|GB|m|s|px|°)\b|(\d)°/g, (m, n, u, d) => d ? `${d} degrees` : `${n} ${UNITS[u] || u}`)
    .replace(/\d[\d,]*(\.\d+)?/g, numberWords)
    .replace(/[*_#|<>{}[\]\\^~`]/g, " ")
    .replace(/\s*\n\s*\n\s*/g, ". ").replace(/\s*\n\s*/g, " ")
    .replace(/([.!?:])\s*\./g, "$1").replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:)])/g, "$1")
    .replace(/\s(in|as|at|from|and|or|see)(?=[:.,;])/g, "").replace(/([,;:])([.!?])/g, "$2").trim();
  if (s.length > MAX_CHARS) s = s.slice(0, s.lastIndexOf(". ", MAX_CHARS) + 1 || MAX_CHARS) + " That's the gist; the rest is on screen.";
  return s;
}


function codeWords(c) {
  if (c.length > 40 || /[(){};=]/.test(c)) return " ";
  if (/[\/.]/.test(c)) return fileWords(c.split("/").pop().replace(/:\d+$/, ""));
  return c.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}
/** A path said as its file's bare name: shared/brain.js:120 → "brain". */
function fileWords(f) { return " " + f.split("/").pop().replace(/:\d+$/, "").replace(/\.\w+(\.gz)?$/, "").replace(/[_.-]+/g, " ") + " "; }

function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100, out = [];
  if (h) out.push(ONES[h] + " hundred");
  if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? "-" + ONES[r % 10] : ""));
  return out.join(" and ");
}
function intWords(n) {
  if (n === 0) return "zero";
  if (n >= 1e12) return String(n).split("").map((d) => ONES[d]).join(" ");
  const out = [];
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (n >= v) { out.push(under1000(Math.floor(n / v)) + " " + w); n %= v; }
  }
  if (n) out.push(under1000(n));
  return out.join(" ");
}
/** Numbers said roughly: 3.47 → three point five, 72.4 → seventy-two, 1,537 → fifteen hundred-ish (two figures). */
function numberWords(m) {
  let x = Number(m.replace(/,/g, ""));
  const year = /^(1[89]|20)\d\d$/.test(m);
  if (!year && x >= 1000) { const k = 10 ** (Math.floor(Math.log10(x)) - 1); x = Math.round(x / k) * k; }
  else if (x >= 10) x = Math.round(x);
  else if (x >= 1) x = Math.round(x * 10) / 10;
  else if (x > 0) x = Number(x.toPrecision(1));
  const [i, f] = String(x).split(".");
  const n = Number(i);
  // Years read as years: 2026 → twenty twenty-six.
  let w = year ? `${under1000(Math.floor(n / 100))} ${n % 100 ? (n % 100 < 10 ? "oh " : "") + under1000(n % 100) : "hundred"}` : intWords(n);
  if (f) w += " point " + f.split("").map((d) => ONES[d]).join(" ");
  return " " + w + " ";
}
