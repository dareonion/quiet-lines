// Pilot tests for the tracing engine and path sampler. Phase 3 (Codex) extends this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer } from './engine.js';
import { samplePath, polylineLength } from './path.js';

const line = samplePath('M100 100 L100 500', 4);            // 400 px vertical line
const circle = samplePath('M300 100 C 410 100, 500 190, 500 300 C 500 410, 410 500, 300 500 C 190 500, 100 410, 100 300 C 100 190, 190 100, 300 100', 4);

function drag(tracer, pts, id = 1) {
  const events = [...tracer.pointerDown(id, ...pts[0])];
  for (const p of pts.slice(1)) events.push(...tracer.pointerMove(id, ...p));
  events.push(...tracer.pointerUp(id));
  return events;
}

const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

test('path sampling keeps endpoints and even spacing', () => {
  assert.deepEqual(line[0], [100, 100]);
  assert.deepEqual(line.at(-1), [100, 500]);
  assert.ok(Math.abs(polylineLength(line) - 400) < 1e-6);
  assert.ok(Math.abs(polylineLength(circle) - 2 * Math.PI * 200) < 10);
});

test('tracing a line top to bottom completes it', () => {
  const t = createTracer([line]);
  const ev = drag(t, range(100, 500, 40).map((y) => [100, y]));
  assert.ok(ev.some((e) => e.type === 'complete'));
});

test('easy mode: bottom to top also completes; normal mode does not', () => {
  const up = range(500, 100, 40).map((y) => [110, y]);
  assert.ok(drag(createTracer([line], { mode: 'easy' }), up).some((e) => e.type === 'complete'));
  assert.ok(!drag(createTracer([line], { mode: 'normal' }), up).some((e) => e.type === 'complete'));
});

test('lifting the finger keeps progress', () => {
  const t = createTracer([line]);
  drag(t, range(100, 300, 20).map((y) => [100, y]));
  assert.ok(!t.complete);
  const ev = drag(t, range(290, 500, 20).map((y) => [100, y]));
  assert.ok(ev.some((e) => e.type === 'complete'));
});

test('lifting and touching down near the far end does not count', () => {
  const t = createTracer([line], { mode: 'normal' });
  drag(t, [[100, 100]]);
  drag(t, range(470, 500, 10).map((y) => [100, y]));
  assert.ok(!t.complete);
});

test('a fast swipe along the line (sparse events) still counts', () => {
  const t = createTracer([line], { mode: 'normal' });
  assert.ok(drag(t, [[100, 100], [100, 480], [100, 500]]).some((e) => e.type === 'complete'));
});

test('clockwise and anticlockwise circles both complete from the same start', () => {
  const around = (sign) => range(0, 2 * Math.PI, 120).map((a) => [300 + sign * 200 * Math.sin(a), 300 - 200 * Math.cos(a)]);
  assert.ok(drag(createTracer([circle]), around(1)).some((e) => e.type === 'complete'));
  assert.ok(drag(createTracer([circle]), around(-1)).some((e) => e.type === 'complete'));
});

test('a second finger is ignored while the first is tracing', () => {
  const t = createTracer([line]);
  t.pointerDown(1, 100, 100);
  t.pointerDown(2, 100, 480);            // resting palm near the far end
  for (const y of range(480, 500, 5)) t.pointerMove(2, 100, y);
  assert.ok(!t.complete);
  for (const y of range(100, 500, 40)) t.pointerMove(1, 100, y);
  assert.ok(t.complete);
});

// ---- Codex review 1 reproductions (2026-11-22) ----

test('a stationary touch on a short stroke does not complete it', () => {
  const short = samplePath('M100 100 L124 100', 4);   // 24 px, shorter than the tolerance
  const t = createTracer([short]);
  t.pointerDown(1, 100, 100);
  t.pointerMove(1, 100, 100);
  t.pointerUp(1, 100, 100);
  assert.ok(!t.complete);
  // ...but dragging along it does.
  assert.ok(drag(t, range(100, 124, 6).map((x) => [x, 100])).some((e) => e.type === 'complete'));
});

test('a row of taps without movement never advances a line', () => {
  // Codex recheck: lift coordinates as the canvas supplies them (pointerUp with a position).
  for (const mode of ['easy', 'normal']) {
    const t = createTracer([line], { mode });
    for (const y of range(100, 500, 100)) { t.pointerDown(1, 100, y); t.pointerUp(1, 100, y); }
    assert.ok(!t.complete, mode);
    assert.deepEqual(t.coverage()[0].ranges, [], mode);
  }
});

test('jittery taps (1 px each) do not creep along a line', () => {
  const t = createTracer([line], { mode: 'normal' });
  for (let i = 0; i < 120; i++) { t.pointerDown(1, 100, 100 + i); t.pointerUp(1, 100, 101 + i); }
  const [[, hi] = [0, 0]] = t.coverage()[0].ranges;
  assert.ok(hi < 5, `crept to sample ${hi}`);
});

test('stationary taps never complete a short stroke', () => {
  const short = samplePath('M100 100 L124 100', 4);
  const t = createTracer([short]);
  for (let i = 0; i < 20; i++) { t.pointerDown(1, 100, 100); t.pointerUp(1, 100, 100); }
  assert.ok(!t.complete);
});

test('a two-stroke letter whose strokes share an end completes when traced as drawn', () => {
  // B-like: a stem down, then a bump from the top back to the bottom (the shared end).
  const stem = samplePath('M100 100 L100 500', 4);
  const bump = samplePath('M100 100 C 400 100, 400 500, 100 500', 4);
  for (const lift of [true, false]) {
    const t = createTracer([stem, bump]);
    t.pointerDown(1, 100, 100);
    for (const p of stem.slice(1)) t.pointerMove(1, ...p);
    if (lift) { t.pointerUp(1, 100, 500); t.pointerDown(1, 100, 100); }
    else for (const y of range(500, 100, 40)) t.pointerMove(1, 100, y);   // slides back up the stem
    const ev = [];
    for (const p of bump.slice(1)) ev.push(...t.pointerMove(1, ...p));
    assert.ok(ev.some((e) => e.type === 'complete'), `lift=${lift}`);
  }
});

test('circle: an off-centre start on either side, traced either way, completes', () => {
  // The start dot is at the top (300,100); the path runs clockwise from it.
  const around = (sign, a0) => range(a0, a0 + sign * 2 * Math.PI, 140).map((a) => [300 + 200 * Math.sin(a), 300 - 200 * Math.cos(a)]);
  for (const offset of [0.1, -0.1]) {        // about 20 px either side of the dot
    for (const sign of [1, -1]) {
      const t = createTracer([circle]);
      const ok = drag(t, around(sign, offset)).some((e) => e.type === 'complete');
      assert.ok(ok, `offset ${offset} direction ${sign}`);
    }
  }
});

test('the lift position counts', () => {
  const t = createTracer([line], { mode: 'normal' });
  t.pointerDown(1, 100, 100);
  for (const y of range(100, 400, 30)) t.pointerMove(1, 100, y);
  assert.ok(!t.complete);
  const ev = t.pointerUp(1, 100, 500);
  assert.ok(ev.some((e) => e.type === 'complete'));
});

test('a cancelled pointer does not count its position, and frees the stroke', () => {
  const t = createTracer([line], { mode: 'normal' });
  t.pointerDown(1, 100, 100);
  t.pointerCancel(1);
  assert.equal(t.activePointer, null);
  t.pointerDown(2, 100, 100);
  assert.equal(t.activePointer, 2);
});

test('progress survives a resize (snapshot / restore at a new scale)', () => {
  const t = createTracer([line], { mode: 'normal' });
  drag(t, range(100, 300, 20).map((y) => [100, y]));
  const snap = t.snapshot();
  const big = samplePath('M200 200 L200 1000', 4);   // the same line at twice the size
  const t2 = createTracer([big], { mode: 'normal' }, snap);
  assert.ok(Math.abs(t2.coverage()[0].ranges[0][1] / big.length - 0.5) < 0.05);
  assert.ok(drag(t2, range(590, 1000, 40).map((y) => [200, y])).some((e) => e.type === 'complete'));
  const t3 = createTracer([big], { mode: 'normal' }, t2.snapshot());
  assert.ok(t3.complete);
});

// ---- Codex review 3 reproductions ----

test('landing 39 px from the start and dragging to the end completes (easy)', () => {
  const t = createTracer([line], { mode: 'easy' });
  t.pointerDown(1, 100 + 39, 100);           // 39 px to the side of the start
  const ev = [];
  for (const y of range(100, 500, 40)) ev.push(...t.pointerMove(1, 100, y));
  assert.ok(ev.some((e) => e.type === 'complete'));
});

test('jittery taps (3 px each, 4 px apart) never complete a short stroke', () => {
  const short = samplePath('M100 100 L124 100', 4);
  for (const mode of ['easy', 'normal']) {
    const t = createTracer([short], { mode });
    for (let i = 0; i < 10; i++) { t.pointerDown(1, 100 + 4 * i, 100); t.pointerUp(1, 103 + 4 * i, 100); }
    assert.ok(!t.complete, mode);
  }
});

test('a drag carried on from the previous stroke cannot lock the next one the wrong way', () => {
  // Stroke A ends where stroke B starts; the tail of A's drag runs a little way along B.
  const a = samplePath('M100 100 L300 100', 4);
  const b = samplePath('M300 100 L300 400', 4);
  const t = createTracer([a, b], { mode: 'easy' });
  t.pointerDown(1, 100, 100);
  for (const x of range(100, 300, 50)) t.pointerMove(1, x, 100);
  for (const y of range(100, 160, 15)) t.pointerMove(1, 300, y);   // the tail wanders down B
  t.pointerUp(1, 300, 160);
  // Now he traces B from its far end, upwards: easy mode allows it.
  t.pointerDown(1, 300, 400);
  const ev = [];
  for (const y of range(400, 100, 75)) ev.push(...t.pointerMove(1, 300, y));
  assert.ok(ev.some((e) => e.type === 'complete'));
});

test('wandering far off the path does not let progress jump ahead', () => {
  const t = createTracer([line], { mode: 'normal' });
  t.pointerDown(1, 100, 100);
  for (const y of range(100, 160, 15)) t.pointerMove(1, 100, y);
  // a long excursion away from the line, then back down near the far end
  for (const x of range(100, 600, 50)) t.pointerMove(1, x, 160);
  for (const y of range(160, 480, 40)) t.pointerMove(1, 600, y);
  for (const x of range(600, 100, 50)) t.pointerMove(1, x, 480);
  t.pointerUp(1, 100, 490);
  assert.ok(!t.complete);
  const [[, hi]] = t.coverage()[0].ranges;
  assert.ok(hi < 40, `jumped to sample ${hi}`);
});
