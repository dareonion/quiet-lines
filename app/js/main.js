import { setAvailable, unlock } from './audio.js';
import { renderHome } from './screens/home.js';
import { renderCard } from './screens/card.js';
import { renderTrace } from './screens/trace.js';
import { renderParent } from './screens/parent.js';
import { renderPicker } from './screens/picker.js';
import { renderDraw } from './screens/draw.js';
import { loadGlyphs } from './glyph.js';
import { AREAS } from './areas.js';
import { installPalmGuard } from './pen.js';

const root = document.getElementById('app');
let cleanup = () => {};
let ctx = null;

// ---------- service worker: updates install in the background, switch only on Home ----------
// The server stamps /sw.js with the release id, so a new recording or code change gives a new
// worker. It installs the whole release (hash-verified), then WAITS. Only the Home screen tells
// it to take over, so an open lesson never changes release under him (plan, "Service-worker
// updates"). The iPad app has a single window, so "the Home screen" means this page on Home.
// The HTML captures this before loading any external resources. A worker from a parent
// scope can also control a first visit to a project site.
const controlledAtLoad = window.pageController?.scriptURL === new URL('sw.js', location.href).href;
let registration = null;
let takingOver = false;
let reloadOnHome = !!navigator.serviceWorker?.controller && window.pageController !== navigator.serviceWorker.controller;
let lastCheck = null;          // 'checking' | 'ok' | 'failed': the parent screen says which
let parentUnlocked = false;    // set only by the 3-second hold; consumed by the route
const statusListeners = new Set();

function onHome() {
  return (location.hash || '#/') === '#/';
}

// Safari tabs and the Home Screen app keep separate storage (WebKit 17.2+), so only the Home
// Screen app's own ✓ means the iPad can go offline.
const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

/** For the parent screen and the corner tag: where the offline copy stands. */
export function swStatus() {
  return {
    standalone,
    supported: 'serviceWorker' in navigator,
    controlled: controlledAtLoad && !reloadOnHome && window.pageController === navigator.serviceWorker?.controller,
    switching: reloadOnHome && !!navigator.serviceWorker?.controller,   // saved; finishes at Home
    installing: !!registration?.installing,
    waiting: !!registration?.waiting,
    lastCheck,
    online: navigator.onLine !== false,
    release: ctx?.release?.id ?? null,
  };
}

export function onSwStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function notify() {
  for (const fn of statusListeners) fn(swStatus());
}

function register() {
  return navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (registration !== reg) {
      registration = reg;
      watch(reg.installing);   // an update may already be installing at launch
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }
    return reg;
  });
}

export function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  // Offline, update() rejects; a release that already downloaded can still take over.
  lastCheck = 'checking';
  notify();
  // A failed first install can leave a registration with no worker. Register again on retry.
  const reg = registration?.active || registration?.installing || registration?.waiting
    ? registration.update() : register();
  return reg.then(() => { lastCheck = 'ok'; }, () => { lastCheck = 'failed'; }).finally(() => maybeTakeOver());
}

function maybeTakeOver() {
  notify();
  if (takingOver || !registration?.waiting || !navigator.serviceWorker.controller || !onHome()) return;
  takingOver = true;
  // Hold taps for the moment the handover takes, so he can't open a lesson that the reload
  // would then throw away. If the handover never comes, let go after 4 s.
  const shield = document.createElement('div');
  shield.className = 'shield';
  document.body.append(shield);
  // A handover slower than that still reloads, at the next visit to Home (see controllerchange).
  setTimeout(() => { if (takingOver) { takingOver = false; reloadOnHome = true; shield.remove(); notify(); } }, 4000);
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

function watch(worker) {
  if (!worker) return;
  const changed = () => {
    if (worker.state === 'redundant' || worker.state === 'installed') {
      worker.removeEventListener('statechange', changed);
      if (worker.state === 'redundant') lastCheck = 'failed';
    }
    notify();
    if (worker.state === 'installed') maybeTakeOver();
  };
  worker.addEventListener('statechange', changed);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // This page's code didn't come from the new worker's cache (an update, or a first install).
    // Reload on Home, where nothing is in progress; elsewhere wait for the next visit to Home.
    // A first install on Home reloads at once, so the ✓ a parent is waiting for appears.
    reloadOnHome = true;
    if (onHome() || root.querySelector('.boot-failed')) location.reload();
    else notify();
  });
  register().then((reg) => {
    maybeTakeOver();
    if (reg.active && !reg.installing) checkForUpdate();
  }).catch(() => { lastCheck = 'failed'; notify(); });
  const recheck = () => { if (document.visibilityState === 'visible') checkForUpdate(); };
  document.addEventListener('visibilitychange', recheck);
  window.addEventListener('pageshow', recheck);
}

// ---------- iPad touch hygiene ----------
// iOS ignores user-scalable=no in some modes; block pinch and double-tap zoom directly.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
// Web Audio can only start inside a gesture: unlock (or revive) it on every lift.
document.addEventListener('pointerup', unlock, { capture: true });
document.addEventListener('touchend', unlock, { capture: true, passive: true });
// Apple Pencil: a hand resting on the screen draws nothing and presses nothing (pen.js).
installPalmGuard();

// ---------- routing ----------
export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Only the parent gate (the 3-second hold) calls this. Back/forward or a restored URL can't. */
export function openParent() {
  parentUnlocked = true;
  location.replace('#/parent');   // replace: the parent screen never sits in history
}

function leaveParent() {
  location.replace('#/');
}

function route() {
  const [, screen, id, page] = (location.hash || '#/').split('/');
  if (screen === 'parent' && !parentUnlocked) { location.replace('#/'); return; }
  parentUnlocked = false;
  if (reloadOnHome && onHome() && !registration?.waiting) { location.reload(); return; }
  cleanup();
  root.replaceChildren();
  const item = id && screen !== 'area' ? ctx.catalog.items.find((i) => i.id === decodeURIComponent(id)) : null;
  const args = { ...ctx, item, go };
  if (screen === 'card' && item) cleanup = renderCard(root, args);
  else if (screen === 'trace' && item?.trace && item?.glyph) cleanup = renderTrace(root, args);
  else if (screen === 'area' && AREAS.some((a) => a.id === id && a.kind)) cleanup = renderPicker(root, { ...args, areaId: id, page: Number(page) || 0 });
  else if (screen === 'draw') cleanup = renderDraw(root, args);
  else if (screen === 'parent') cleanup = renderParent(root, { ...args, go: leaveParent, swStatus, onSwStatus, checkForUpdate });
  else cleanup = renderHome(root, { ...args, openParent, swStatus, onSwStatus });
  root.dataset.screen = screen || 'home';
  if (onHome()) maybeTakeOver();
}

let booting = false;
async function boot() {
  if (ctx || booting) return;
  booting = true;
  try {
    const [catalog, release] = await Promise.all([
      fetch('content/catalog.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch('release.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
    const glyphs = await loadGlyphs(catalog);
    setAvailable(release.clips, release.voices, catalog.clips);
    ctx = { catalog, glyphs, release };
    window.addEventListener('hashchange', route);
    route();
    document.documentElement.dataset.ready = '1';
    // A slow first load can outlast index.html's 8-second "couldn't load" fallback: take it down.
    document.getElementById('boot-fallback')?.setAttribute('hidden', '');
  } catch {
    // The connection dropped before anything was saved. A calm screen with one big retry button;
    // it also retries by itself when the offline copy takes over (controllerchange).
    if (reloadOnHome) { location.reload(); return; }
    root.replaceChildren();
    const el = document.createElement('section');
    el.className = 'screen boot-failed';
    el.innerHTML = `<div class="boot-body"><button class="round big" aria-label="Try again">${RETRY}</button>
      <p>Couldn't load. Check the iPad is online, then tap to try again.</p></div>`;
    // Retry the offline setup too: if the first registration failed, nothing else retries it.
    el.querySelector('button').addEventListener('click', () => { checkForUpdate(); boot(); });
    root.append(el);
  } finally {
    booting = false;
  }
}
const RETRY = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M48 32 A16 16 0 1 1 41 18.7"/><path d="M42 8 L42 20 L30 20"/></svg>';

boot();
