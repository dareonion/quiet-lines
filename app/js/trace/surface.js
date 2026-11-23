// Trace surface: canvas rendering + pointer input, feeding the pure engine.
// Calm rules: ink always appears and fades; nothing moves unless he touches; the finished glyph
// fills in softly (<= 300 ms) and then everything waits.

import { createTracer } from './engine.js';
import { layoutGlyph } from '../glyph.js';
import { palm } from '../pen.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const INK_FADE_MS = 300;   // calm rule 2: motion <= 300 ms
const FILL_MS = 300;

export class TraceSurface {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} glyph  from resolveGlyph() (latin strokes or hanzi outlines + medians)
   * @param {{mode?: 'easy'|'normal', onComplete?: () => void}} opts
   */
  constructor(canvas, glyph, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.glyph = glyph;
    this.mode = opts.mode ?? 'easy';
    this.onComplete = opts.onComplete ?? (() => {});
    this.ink = new Map();          // pointerId -> {pts: [[x,y,t]], color}
    this.fading = [];              // finished ink trails, fading out
    this.fillStart = null;         // when the finished glyph started filling
    this.raf = null;
    this.colors = {
      guide: css('--guide'), dot: css('--dot'), trace: css('--trace'), done: css('--done'), ink: css('--ink-soft'),
    };
    this._bind();
    this.resize();
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    this._down = (e) => {
      e.preventDefault();
      if (palm.isPalm(e.pointerId)) return;      // a resting hand, while the Pencil is in use (pen.js)
      c.setPointerCapture?.(e.pointerId);
      const [x, y] = pos(e);
      this.ink.set(e.pointerId, { pts: [[x, y, performance.now()]] });
      this._handle(this.tracer.pointerDown(e.pointerId, x, y));
      this._kick();
    };
    this._move = (e) => {
      if (palm.isPalm(e.pointerId)) return;
      let trail = this.ink.get(e.pointerId);
      if (!trail) {
        // A finger still down across a rotation/resize: pick it up again as a new touch.
        if (!e.buttons && !(e.pointerType === 'touch' && e.pressure > 0)) return;
        this._down(e);
        trail = this.ink.get(e.pointerId);
      }
      e.preventDefault();
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (list.length ? list : [e])) {
        const [x, y] = pos(ev);
        trail.pts.push([x, y, performance.now()]);
        this._handle(this.tracer.pointerMove(e.pointerId, x, y));
      }
      this._kick();
    };
    this._end = (e, counts) => {
      const trail = this.ink.get(e.pointerId);
      if (trail) {
        trail.ended = performance.now();
        this.fading.push(trail);
        this.ink.delete(e.pointerId);
      }
      if (counts && trail && !palm.isPalm(e.pointerId)) {
        const [x, y] = pos(e);   // the lift position counts: it can be past the last move
        this._handle(this.tracer.pointerUp(e.pointerId, x, y));
      } else {
        this.tracer.pointerCancel(e.pointerId);
      }
      this._kick();
    };
    this._drop = (id) => {
      const trail = this.ink.get(id);
      trail.ended = performance.now();
      this.fading.push(trail);
      this.ink.delete(id);
      this.tracer.pointerCancel(id);
    };
    this._up = (e) => this._end(e, true);
    this._cancel = (e) => this._end(e, false);
    c.addEventListener('pointerdown', this._down);
    c.addEventListener('pointermove', this._move);
    c.addEventListener('pointerup', this._up);
    c.addEventListener('pointercancel', this._cancel);
    c.addEventListener('lostpointercapture', this._cancel);
    // The Pencil landed (anywhere): touches still down are a resting hand. Their ink fades; they stop counting.
    this._unPalm = palm.onPalms((ids) => {
      for (const id of ids) if (this.ink.has(id)) this._drop(id);
      this._kick();
    });
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    c.removeEventListener('pointerup', this._up);
    c.removeEventListener('pointercancel', this._cancel);
    c.removeEventListener('lostpointercapture', this._cancel);
    window.removeEventListener('resize', this._onResize);
    this._unPalm();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  resize() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
    const side = Math.min(r.width, r.height) * 0.78;
    this.side = side;
    this.ox = (r.width - side) / 2;
    this.oy = (r.height - side) / 2;
    // Rotation or resize: rebuild the geometry but keep his progress (and a finished glyph
    // stays finished). Fingers on the glass are ended; a finger still down picks up again.
    this._build(this.tracer ? this.tracer.snapshot() : null);
    if (this.fillStart !== null) this.fillStart = -Infinity;
  }

  _build(snap) {
    const step = 4; // screen px between samples
    this.layout = layoutGlyph(this.glyph, { ox: this.ox, oy: this.oy, side: this.side, step });
    this.strokePts = this.layout.strokePts;
    this.lineWidth = this.layout.lineWidth;
    const tolerance = this.mode === 'easy' ? 40 : 26;
    this.tracer = createTracer(this.strokePts, { tolerance, mode: this.mode, step }, snap);
    this.ink.clear();
    this.fading = [];
    this._kick();
  }

  /** Start over: same glyph, progress cleared. */
  restart() {
    this.fillStart = null;
    this._build(null);
  }

  _handle(events) {
    for (const ev of events) {
      if (ev.type === 'complete') {
        this.fillStart = performance.now();
        this.onComplete();
      }
    }
  }

  _kick() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this._frame());
  }

  _frame() {
    this.raf = null;
    const now = performance.now();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const polyline = (pts, lo = 0, hi = pts.length - 1) => {
      ctx.beginPath();
      ctx.moveTo(pts[lo][0], pts[lo][1]);
      for (let i = lo + 1; i <= hi; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (lo === hi) ctx.lineTo(pts[lo][0] + 0.01, pts[lo][1]);
      ctx.stroke();
    };

    const L = this.layout;
    const hanzi = L.kind === 'hanzi';
    // Paint a whole glyph in one colour (the finished state, and its cross-fade).
    const paintAll = (color) => {
      if (hanzi) L.fillOutlines(ctx, color);
      else {
        ctx.strokeStyle = color;
        ctx.lineWidth = this.lineWidth * 0.62;
        for (const pts of this.strokePts) polyline(pts);
      }
    };

    // 1. faint guide
    if (hanzi) L.fillOutlines(ctx, this.colors.guide);
    else {
      ctx.strokeStyle = this.colors.guide;
      ctx.lineWidth = this.lineWidth;
      for (const pts of this.strokePts) polyline(pts);
    }

    // 2. progress (blue), or the finished glyph filling in (sage)
    let animating = false;
    if (this.fillStart !== null) {
      const t = Math.min(1, (now - this.fillStart) / FILL_MS);
      paintAll(this.colors.trace);
      ctx.globalAlpha = t;
      paintAll(this.colors.done);
      ctx.globalAlpha = 1;
      animating = t < 1;
    } else {
      ctx.strokeStyle = this.colors.trace;
      this.tracer.coverage().forEach((cov, i) => {
        if (hanzi && cov.done) { L.fillOutlines(ctx, this.colors.trace, [i]); return; }
        if (!cov.ranges.length) return;
        if (hanzi) {
          // Inside the brush shape of this stroke, so it reads as the stroke filling in.
          L.clipTo(ctx, i);
          ctx.lineWidth = this.lineWidth * 2.2;
          for (const [lo, hi] of cov.ranges) polyline(this.strokePts[i], lo, hi);
          ctx.restore();
        } else {
          ctx.lineWidth = this.lineWidth * 0.62;
          for (const [lo, hi] of cov.ranges) polyline(this.strokePts[i], lo, hi);
        }
      });
      // 3. where to start / continue
      ctx.fillStyle = this.colors.dot;
      for (const [x, y] of this.tracer.startPoints()) {
        ctx.beginPath();
        ctx.arc(x, y, this.lineWidth * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 4. his ink: always appears, then fades
    ctx.strokeStyle = this.colors.ink;
    ctx.lineWidth = 12;
    const drawTrail = (trail, alpha) => {
      if (trail.pts.length === 0 || alpha <= 0) return;
      ctx.globalAlpha = alpha * 0.55;
      polyline(trail.pts);
    };
    for (const trail of this.ink.values()) drawTrail(trail, 1);
    this.fading = this.fading.filter((trail) => now - trail.ended < INK_FADE_MS);
    for (const trail of this.fading) drawTrail(trail, 1 - (now - trail.ended) / INK_FADE_MS);
    ctx.globalAlpha = 1;

    if (animating || this.fading.length) this._kick();
  }
}
