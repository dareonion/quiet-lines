import { icons } from '../icons.js';
import { AREAS } from '../areas.js';
import { palm } from '../pen.js';

const HOLD_MS = 3000;

/** Home: five big tiles (Draw, Shapes, 123, ABC, 中文), the parent corner and a tiny status tag. */
export function renderHome(root, { go, openParent, swStatus, onSwStatus }) {
  const el = document.createElement('section');
  el.className = 'screen home';
  el.innerHTML = `
    <div class="home-grid"></div>
    <button class="parent-corner" aria-label="Parents: press and hold">${icons.gear}</button>
    <div class="release-tag"></div>`;
  const grid = el.querySelector('.home-grid');
  for (const area of AREAS) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.dataset.area = area.id;
    b.setAttribute('aria-label', area.label);
    b.innerHTML = area.icon ?? `<span class="glyph area-text">${area.text}</span>`;
    b.addEventListener('click', () => go(area.id === 'draw' ? '#/draw' : `#/area/${area.id}/0`));
    grid.append(b);
  }

  // Parents: press and hold the gear for 3 s, without sliding off it. A tap does nothing.
  const gear = el.querySelector('.parent-corner');
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  gear.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cancel();
    if (palm.isPalm(e.pointerId)) return;      // a hand resting while the Pencil is in use (pen.js)
    const id = e.pointerId;
    // Touch pointers are implicitly captured, so pointerleave wouldn't fire when the finger
    // slides away: release the capture, and also check the position on every move.
    if (gear.hasPointerCapture?.(e.pointerId)) gear.releasePointerCapture(e.pointerId);
    timer = setTimeout(() => { timer = null; if (!palm.isPalm(id)) openParent(); }, HOLD_MS);
  });
  gear.addEventListener('pointermove', (e) => {
    const r = gear.getBoundingClientRect();
    if (e.clientX < r.left - 8 || e.clientX > r.right + 8 || e.clientY < r.top - 8 || e.clientY > r.bottom + 8) cancel();
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) gear.addEventListener(t, cancel);

  // A tiny tag for parents: the release, and ✓ once this copy works offline.
  const tag = el.querySelector('.release-tag');
  const show = (s) => {
    const id = s.release ? s.release.slice(0, 6) : '';
    // ✓ only inside the Home Screen app: a Safari tab's offline copy isn't the app's.
    const mark = !s.standalone ? ' (browser tab)' : s.controlled && !s.installing ? ' ✓' : ' …';
    tag.textContent = `${id}${mark}`;
  };
  show(swStatus());
  const off = onSwStatus(show);

  root.append(el);
  return () => { cancel(); off(); };
}
