import { icons } from '../icons.js';
import { palm } from '../pen.js';

// Free drawing: a blank page, five muted crayons and "new page" (6 choices, calm rule 5). Every
// finger draws, blobs and all, except a hand resting while the Apple Pencil is in use (pen.js).
// Apple Pencil pressure sets the width. No undo, no stamps, no sounds.
const CRAYONS = ['#4a4036', '#c98b6b', '#d4b36a', '#7f9f7b', '#6f8fad'];
const FINGER_WIDTH = 14;
const CLEAR_MS = 250;

export function renderDraw(root, { go }) {
  const el = document.createElement('section');
  el.className = 'screen draw';
  el.innerHTML = `
    <div class="bar">
      <button class="round" data-act="home" aria-label="Home">${icons.home}</button>
      <div class="crayons"></div>
      <button class="round" data-act="new" aria-label="New page">${icons.newPage}</button>
    </div>
    <div class="draw-stage"><canvas></canvas></div>`;
  root.append(el);
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let color = CRAYONS[0];
  const strokes = [];             // finished and live strokes: {color, pts: [[x, y, w]], page: [w, h]}
  let page = [1, 1];              // the drawing area's size now, in CSS px
  const live = new Map();         // pointerId -> stroke

  const box = el.querySelector('.crayons');
  for (const c of CRAYONS) {
    const b = document.createElement('button');
    b.className = 'crayon';
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', 'crayon');
    b.setAttribute('aria-pressed', String(c === color));
    b.addEventListener('click', () => {
      color = c;
      box.querySelectorAll('.crayon').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    box.append(b);
  }

  const width = (e) => (e.pointerType === 'pen' ? 3 + 13 * (e.pressure || 0.5) : FINGER_WIDTH);

  function segment(s, i) {
    const [x0, y0, w0] = s.pts[i - 1];
    const [x1, y1, w1] = s.pts[i];
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (w0 + w1) / 2;
    ctx.beginPath();
    if (i >= 2) {
      // Smooth: from the previous midpoint, curving through the previous point.
      const [xp, yp] = s.pts[i - 2];
      ctx.moveTo((xp + x0) / 2, (yp + y0) / 2);
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }

  // The last bit of a smoothed stroke: from the final midpoint to where the finger lifted.
  function finish(s) {
    const n = s.pts.length;
    if (n < 3) return;
    const [xp, yp] = s.pts[n - 2];
    const [x, y, w] = s.pts[n - 1];
    ctx.strokeStyle = s.color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo((xp + x) / 2, (yp + y) / 2);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function dot(s) {
    const [x, y, w] = s.pts[0];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(x, y, w / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function redraw() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    for (const s of strokes) {
      // Drawn on a page of a different shape (before a rotation): scale it to fit, centred.
      const k = Math.min(page[0] / s.page[0], page[1] / s.page[1]);
      ctx.save();
      ctx.translate((page[0] - s.page[0] * k) / 2, (page[1] - s.page[1] * k) / 2);
      ctx.scale(k, k);
      dot(s);
      for (let i = 1; i < s.pts.length; i++) segment(s, i);
      if (!live.has(s.pointerId) || live.get(s.pointerId) !== s) finish(s);
      ctx.restore();
    }
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Rotation keeps the drawing. A stroke still in progress is ended (its finger starts afresh).
    for (const [id, s] of live) if (s.page[0] !== r.width || s.page[1] !== r.height) live.delete(id);
    page = [r.width, r.height];
    redraw();
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, width(e)];
  };
  // The Pencil landed (anywhere): touches still down are a resting hand, so their ink goes.
  function dropPalms() {
    let dropped = false;
    for (const [id, s] of live) {
      if (!palm.isPalm(id)) continue;
      live.delete(id);
      strokes.splice(strokes.indexOf(s), 1);
      dropped = true;
    }
    if (dropped) redraw();
  }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (palm.isPalm(e.pointerId)) return;
    canvas.setPointerCapture?.(e.pointerId);
    const s = { color, pts: [pos(e)], page: [...page], pointerId: e.pointerId };
    strokes.push(s);
    live.set(e.pointerId, s);
    dot(s);
  });
  canvas.addEventListener('pointermove', (e) => {
    const s = live.get(e.pointerId);
    if (!s) return;
    e.preventDefault();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (list.length ? list : [e])) {
      s.pts.push(pos(ev));
      segment(s, s.pts.length - 1);
    }
  });
  const end = (e) => {
    const s = live.get(e.pointerId);
    if (!s) return;
    live.delete(e.pointerId);
    if (e.type === 'pointerup') {
      const p = pos(e);
      const [lx, ly] = s.pts[s.pts.length - 1];
      if (p[0] !== lx || p[1] !== ly) { s.pts.push(p); segment(s, s.pts.length - 1); }
    }
    finish(s);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  el.querySelector('[data-act="new"]').addEventListener('click', () => {
    strokes.length = 0;
    live.clear();
    canvas.classList.add('clearing');          // a short fade, then a fresh page
    setTimeout(() => { redraw(); canvas.classList.remove('clearing'); }, CLEAR_MS);
  });
  el.querySelector('[data-act="home"]').addEventListener('click', () => go('#/'));
  window.addEventListener('resize', resize);
  const unPalm = palm.onPalms(dropPalms);
  resize();
  window.__draw = { strokes };     // for the Playwright tests
  return () => { window.removeEventListener('resize', resize); unPalm(); window.__draw = null; };
}
