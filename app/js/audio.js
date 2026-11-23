// Voice clips via Web Audio. Calm rules: sound only on his action; a new clip stops the previous
// one (never overlapping); a missing clip plays nothing (there is no TTS fallback).
//
// iPad Safari specifics:
// - Audio can only start inside a user gesture (pointerup/touchend). main.js calls unlock() on
//   every such gesture; it creates or revives the AudioContext there.
// - A Home Screen app coming back from the background can find its context "interrupted" or
//   unable to resume. If a resume didn't take, the next gesture replaces the context.
// - A trace finishes during a pointermove, which isn't a gesture. If audio isn't running yet, the
//   clip is held and played by the lift (pointerup) that follows, if that comes within 6 s.

import { getSettings } from './settings.js';

let ctx = null;
let resumeFailed = false;
let current = null;            // {src, resolve} of the clip playing now
let available = {};            // release key -> {take_id, sha256}
let catalog = {};              // logical clip id -> {lang, ...}
let packs = {};
let defaults = {};             // language -> shipped default pack id
const buffers = new Map();     // "clip@take" -> AudioBuffer (successes only)
let token = 0;                 // bumps on every play/sequence/silence; stale work gives up
let held = null;               // {ids, at}: asked to play before audio was running

/** Install the release's recordings and the catalog used to resolve their language. */
export function setAvailable(clips, voices, catalogClips) {
  available = clips ?? {};
  catalog = catalogClips ?? {};
  packs = voices?.packs ?? {};
  defaults = {};
  for (const [id, pack] of Object.entries(packs)) {
    if (pack.default) defaults[pack.lang] = id;
  }
}

export function selectedVoice(lang, choices = getSettings().voices) {
  const id = choices?.[lang];
  return packs[id]?.lang === lang ? id : defaults[lang];
}

function resolveClip(id, choices) {
  const lang = catalog[id]?.lang;
  if (lang && defaults[lang]) {
    const selected = `${selectedVoice(lang, choices)}/${id}`;
    if (available[selected]) return selected;
    const fallback = `${defaults[lang]}/${id}`;
    if (available[fallback]) return fallback;
  }
  return id;
}

export function hasClip(id) {
  return !!(id && available[resolveClip(id, getSettings().voices)]);
}

function running() {
  return ctx && ctx.state === 'running';
}

/** Call inside a user gesture. */
export function unlock() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!ctx || ctx.state === 'closed' || ctx.state === 'interrupted' || resumeFailed) {
    try { ctx?.close(); } catch { /* already closed */ }
    ctx = new AC();
    buffers.clear();             // decoded buffers belong to the old context on some WebKits
    resumeFailed = false;
  }
  if (ctx.state !== 'running') {
    const c = ctx;
    c.resume().then(() => { if (c === ctx && c.state !== 'running') resumeFailed = true; })
      .catch(() => { if (c === ctx) resumeFailed = true; });
    // A resume that never settles (seen on WebKit after backgrounding) counts as failed too.
    setTimeout(() => { if (c === ctx && c.state !== 'running') resumeFailed = true; }, 1000);
  }
  // A one-sample silent buffer completes the unlock on older iPadOS.
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* nothing to unlock with */ }
  if (held && performance.now() - held.at < 6000) {
    const ids = held.ids;
    held = null;
    playSequence(ids);
  }
  held = null;
}

async function bufferFor(id) {
  const key = `${id}@${available[id].take_id}`;
  if (buffers.has(key)) return buffers.get(key);
  try {
    const r = await fetch(`audio/${id}.m4a`);
    if (!r.ok) return null;
    const buf = await decode(await r.arrayBuffer());
    if (buf) buffers.set(key, buf);   // a failure is retried on the next tap
    return buf;
  } catch {
    return null;
  }
}

function decode(data) {
  // The promise form is missing on some older Safari builds: use the callback form.
  return new Promise((resolve) => ctx.decodeAudioData(data, resolve, () => resolve(null)));
}

function stopCurrent() {
  if (current) {
    const { src, resolve } = current;
    current = null;
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
    resolve(false); // interrupted: a waiting sequence stops here
  }
}

/** Plays one clip; resolves true when it finished, false if missing/interrupted. */
async function playOne(id, mine) {
  const buf = await bufferFor(id);
  if (!buf || mine !== token) return false;
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  if (mine !== token || ctx.state !== 'running') return false;   // cancelled while resuming
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  return new Promise((resolve) => {
    current = { src, resolve };
    src.onended = () => { if (current?.src === src) current = null; resolve(true); };
    src.start(0);
  });
}

/** Says clips one after another (e.g. English then 中文). Any later call cancels this one. */
export async function playSequence(ids) {
  const choices = getSettings().voices;
  const resolved = ids.map((id) => resolveClip(id, choices));
  window.__plays?.push(resolved);       // test hook: what was asked for, before missing clips drop out
  const mine = ++token;
  held = null;                     // any newer request replaces a held one, even a silent one
  stopCurrent();
  const wanted = resolved.filter((id) => available[id]);
  if (!wanted.length) return;
  if (!running()) {
    held = { ids: wanted, at: performance.now() };   // the coming pointerup will play it
    if (ctx) await ctx.resume().catch(() => {});
    if (!running() || mine !== token) return;
    held = null;
  }
  for (const id of wanted) {
    if (mine !== token) return;
    if (!(await playOne(id, mine))) return;
  }
}

/** Cancel any sequence, held clip and the clip that's playing. */
export function silence() {
  token++;
  held = null;
  stopCurrent();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') silence();
  // WebKit Home Screen apps can come back with a context that says "running" but is silent
  // (WebKit bug 291892). Replace it on the first tap after returning.
  else if (ctx) resumeFailed = true;
});
