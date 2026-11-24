// Every traceable glyph in the catalog completes when traced as drawn, forwards and (easy mode)
// backwards, at iPad size, with sparse finger samples that cut corners. Catches stroke data the
// engine can't follow, and handoff stalls between strokes that share an end (B, D, heart, 口).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTracer } from './engine.js';
import { samplePath, resample } from './path.js';

const root = new URL('../../', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, root)));
const catalog = read('content/catalog.json');
const latin = read('content/glyphs/latin.json');
const step = 4;
// Trace-area sides at the four iPad viewports (0.78 x the smaller canvas side), and how sparse the
// finger samples are (every k-th path sample: fast fingers and corner cutting).
const SIDES = [470, 500, 560, 640];
// Up to every 16th path sample: 64 px between finger samples, i.e. heavy corner cutting. (At every
// 24th, 96 px, which is a swipe of about 5,000 px/s at 60 Hz and nothing like tracing, sharp shapes
// such as the star, 3, 9, B and W can stall in easy mode: the direction rule rejects a chord that
// cuts a sharp tip at more than 105 degrees. Known and accepted, 2026-11-22.)
const SPARSE = [(n) => Math.max(1, Math.floor(n / 40)), () => 16];
const NORMAL_SPARSE = SPARSE;
const TOL = { easy: 40, normal: 26 };   // the surface's production tolerances

function screenStrokes(ref, side) {
  const ox = 200, oy = 60;
  const [set, name] = ref.split(':');
  if (set === 'latin') {
    const sc = side / latin.box;
    return latin.glyphs[name].strokes.map((d) => samplePath(d, step / sc).map(([x, y]) => [ox + x * sc, oy + y * sc]));
  }
  const g = read(`content/glyphs/hanzi/${name.codePointAt(0).toString(16)}.json`);
  const sc = side / g.box;
  return g.medians.map((m) => resample(m.map(([x, y]) => [ox + x * sc, oy + (g.y_flip - y) * sc]), step));
}

// A steady sideways offset along the path's normal: a careful trace held to one side of the line.
function sideways(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * off, p[1] + (dx / L) * off];
  });
}

function traceAll(strokes, mode, { reverse = false, every = SPARSE[0], offset = 0, side = 0 } = {}) {
  const t = createTracer(strokes, { tolerance: TOL[mode], mode, step });
  for (let pts of strokes) {
    if (reverse) pts = pts.slice().reverse();
    if (side) pts = sideways(pts, side);
    const k = every(pts.length);
    const path = pts.filter((_, i) => i % k === 0).concat([pts.at(-1)]).map(([x, y]) => [x, y + offset]);
    t.pointerDown(1, ...path[0]);
    for (const p of path.slice(1)) t.pointerMove(1, ...p);
    t.pointerUp(1, ...path.at(-1));
  }
  return t.complete;
}

const traceable = catalog.items.filter((i) => i.trace);

test('there are traceable items', () => assert.ok(traceable.length > 50));

for (const item of traceable) {
  test(`${item.id} traces to completion at every iPad size`, () => {
    for (const side of SIDES) {
      const strokes = screenStrokes(item.glyph, side);
      for (const [i, every] of SPARSE.entries()) {
        const where = `side ${side}, sparsity ${i}`;
        if (NORMAL_SPARSE.includes(every)) assert.ok(traceAll(strokes, 'normal', { every }), `normal, as drawn, ${where}`);
        assert.ok(traceAll(strokes, 'easy', { every }), `easy, as drawn, ${where}`);
        assert.ok(traceAll(strokes, 'easy', { every, reverse: true }), `easy, each stroke backwards, ${where}`);
      }
      assert.ok(traceAll(strokes, 'easy', { offset: 1 }), `easy, 1 px off the line, side ${side}`);
      assert.ok(traceAll(strokes, 'easy', { offset: 1, reverse: true }), `easy, 1 px off, backwards, side ${side}`);
      // Codex review 4: careful traces 18 px to either side of the line, dense samples.
      for (const off of [18, -18]) {
        assert.ok(traceAll(strokes, 'easy', { side: off, every: () => 1 }), `easy, ${off} px beside the line, side ${side}`);
        assert.ok(traceAll(strokes, 'easy', { side: off, every: () => 1, reverse: true }), `easy, ${off} px beside, backwards, side ${side}`);
      }
    }
  });
}

// Shapes trace "free" (engine.js): strokes in any order, from either end, in either mode, and a
// closed shape from anywhere on it. Every shape, every size, both sparsities: its strokes in
// reverse order, each forwards and backwards; a closed one also from 7 other places round it.
const isClosed = (pts) => Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1;

function traceFree(strokes, mode, { order, reverse = false, every, from = 0 }) {
  const t = createTracer(strokes, { tolerance: TOL[mode], mode, step, free: true });
  for (const i of order) {
    let pts = strokes[i];
    if (from && isClosed(pts)) {
      const m = pts.length - 1, r = Math.round(from * m);
      pts = [...pts.slice(r, m), ...pts.slice(0, r + 1)];
    }
    if (reverse) pts = pts.slice().reverse();
    const k = every(pts.length);
    const path = pts.filter((_, j) => j % k === 0).concat([pts.at(-1)]);
    t.pointerDown(1, ...path[0]);
    for (const p of path.slice(1)) t.pointerMove(1, ...p);
    t.pointerUp(1, ...path.at(-1));
  }
  return t.complete;
}

for (const item of traceable.filter((i) => i.kind === 'shape')) {
  test(`${item.id} traces in any order, either way, and (if closed) from anywhere`, () => {
    for (const side of SIDES) {
      const strokes = screenStrokes(item.glyph, side);
      const order = strokes.map((_, i) => i).reverse();
      const starts = strokes.some(isClosed) ? [0, 1, 2, 3, 4, 5, 6, 7].map((j) => j / 8) : [0];
      for (const mode of ['easy', 'normal']) {
        for (const [i, every] of SPARSE.entries()) {
          for (const from of starts) {
            for (const reverse of [false, true]) {
              assert.ok(traceFree(strokes, mode, { order, reverse, every, from }),
                `${mode}, strokes in reverse order${reverse ? ', each backwards' : ''}, from ${from}, side ${side}, sparsity ${i}`);
            }
          }
        }
      }
    }
  });
}
