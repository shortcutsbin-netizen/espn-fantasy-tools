/**
 * LLM Data Export — formatting.
 *
 * A plain module so it can be tested by behaviour. The same text is shown,
 * copied and downloaded: what a member reads on the page is byte-for-byte what
 * the assistant receives.
 */

const WIDTH = 100;        // a generic node goes on one line if it fits in this
const RECORD_WIDTH = 480; // a record inside a list goes on one line up to this

/* A record is an object whose values are primitives, or containers that
   themselves hold only primitives: a player, a transaction, a fixture. One
   record per line keeps a roster readable and costs a fraction of the tokens
   a fully expanded one would. */
function isRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || typeof x !== 'object'
    || (Array.isArray(x) ? x : Object.values(x)).every((y) => y === null || typeof y !== 'object'));
}

/* Both are cached per object. The export's data is never modified once built, so a
   subtree's text depends only on the object (and, formatted, on its indent and whether
   it sits in a list). Each level otherwise re-serialised its whole subtree to test the
   one-line fit, and picking another team re-formatted sections it had not touched. */
const INLINE = new WeakMap();
function inline(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const hit = INLINE.get(v); if (hit !== undefined) return hit;
  let out;
  if (Array.isArray(v)) out = v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  else { const keys = Object.keys(v); out = keys.length ? `{${keys.map((k) => `${JSON.stringify(k)}: ${inline(v[k])}`).join(', ')}}` : '{}'; }
  INLINE.set(v, out); return out;
}

const FORMATTED = new WeakMap();
function fmt(v, indent, inList) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const key = indent.length + (inList ? 'L' : 'O');
  let seen = FORMATTED.get(v);
  if (seen) { const hit = seen.get(key); if (hit !== undefined) return hit; } else { seen = new Map(); FORMATTED.set(v, seen); }
  let out;
  const one = inline(v);
  if (indent.length + one.length <= WIDTH || (inList && isRecord(v) && one.length <= RECORD_WIDTH)) out = one;
  else {
    const next = `${indent}  `;
    out = Array.isArray(v)
      ? `[\n${v.map((x) => next + fmt(x, next, true)).join(',\n')}\n${indent}]`
      : `{\n${Object.keys(v).map((k) => `${next}${JSON.stringify(k)}: ${fmt(v[k], next, false)}`).join(',\n')}\n${indent}}`;
  }
  seen.set(key, out); return out;
}

export function formatExport(doc) {
  return `${fmt(doc, '', false)}\n`;
}

/** Where each top-level section starts and how much of the file it is. */
/* A section's size is measured once per section object: picking another team rebuilds
   only the sections it changes, so the rest reuse their size exactly. */
const SIZE_CACHE = new WeakMap();
function sectionBytes(v) {
  if (v && typeof v === 'object') { const hit = SIZE_CACHE.get(v); if (hit !== undefined) return hit; }
  const n = new TextEncoder().encode(inline(v)).length;
  if (v && typeof v === 'object') SIZE_CACHE.set(v, n);
  return n;
}

export function sectionMap(doc, text) {
  const lines = text.split('\n');
  const total = new TextEncoder().encode(text).length;
  return Object.keys(doc).map((key) => {
    const line = lines.findIndex((l) => l.startsWith(`  ${JSON.stringify(key)}:`));
    const bytes = sectionBytes(doc[key]);
    return { key, line, bytes, share: total ? bytes / total : 0 };
  });
}

export function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/* One regex over each line. Strings are matched first so punctuation inside a
   string is never mistaken for structure; a string followed by a colon is a key. */
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

const LINE_CACHE = new Map();
/** Cached by the line's text: switching team changes a few lines of thousands. */
export function highlightLine(line) {
  const hit = LINE_CACHE.get(line); if (hit !== undefined) return hit;
  const out = highlightLineRaw(line);
  if (LINE_CACHE.size > 50000) LINE_CACHE.clear();
  LINE_CACHE.set(line, out); return out;
}
function highlightLineRaw(line) {
  let out = '';
  let last = 0;
  line.replace(TOKEN, (m, str, colon, num, lit, punct, at) => {
    out += esc(line.slice(last, at));
    if (str) {
      out += colon
        ? `<span class="jk">${esc(str)}</span><span class="jp">${colon}</span>`
        : `<span class="js">${esc(str)}</span>`;
    } else if (num) out += `<span class="jn">${num}</span>`;
    else if (lit) out += `<span class="jl">${lit}</span>`;
    else out += `<span class="jp">${punct}</span>`;
    last = at + m.length;
    return m;
  });
  return out + esc(line.slice(last));
}

/**
 * The whole viewer body as one HTML string. Built once per export rather than
 * as a React element per token: a full league is a few thousand lines and tens
 * of thousands of spans, which is a noticeable stall on a phone as elements.
 */
export function highlightExport(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  /* The line number is written out rather than counted in CSS. A counter over
     a few thousand lines is recalculated on every style change, which is most
     of what made a long file scroll badly on a phone. */
  return lines.map(lineHtml).join('');
}

/** One line of the viewer: its anchor, its number, and its highlighted text. */
export function lineHtml(l, i) {
  const depth = l.length - l.trimStart().length;
  return `<div class="jline" id="jl-${i}" style="--d:${depth}">`
    + `<span class="jnum">${i + 1}</span>${highlightLine(l.trimStart()) || ' '}</div>`;
}

/**
 * How a new document differs from the one shown: the lines shared at the start (p) and
 * at the end (s). Only the lines between them need building; lines after them only need
 * renumbering if the middle changed length. When most of the document changed (another
 * version, a first view), rebuilding it whole is simpler and no slower.
 */
export function lineDiff(prev, next) {
  if (!prev || !prev.length || !next.length) return { rebuild: true, p: 0, s: 0 };
  const max = Math.min(prev.length, next.length);
  let p = 0; while (p < max && prev[p] === next[p]) p++;
  let s = 0; while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const changed = next.length - p - s;
  return { rebuild: changed > next.length / 2, p, s };
}

/**
 * "<league name>-data-DD-MM-YY.json". Punctuation and symbols are removed from
 * the league name and runs of spaces become one underscore. The date is the day
 * of the download in the site's chosen time zone.
 */
export function downloadName(leagueName, when = new Date(), timeZone) {
  const name = String(leagueName || '').normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, '_') || 'league';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone })
      .formatToParts(when);
  } catch (e) {
    parts = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
      .formatToParts(when);
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  return `${name}-data-${get('day')}-${get('month')}-${get('year')}.json`;
}
