// Pilot tests for the tracing engine and path sampler. Phase 3 (Codex) extends this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer } from './engine.js';
import { samplePath, polylineLength } from './path.js';
import fs from 'node:fs';

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

// ---- agy review (2026-11-23) ----

test('a finger landing just off the line and sliding onto it is picked up', () => {
  const t = createTracer([line]);
  const pts = [[100, 40], [100, 60], [100, 80], ...range(100, 500, 40).map((y) => [100, y])];   // lands 60 px above the start
  assert.ok(drag(t, pts).some((e) => e.type === 'complete'));
});

test('a finger sliding onto the middle of the line arms no direction there', () => {
  const t = createTracer([line]);
  const pts = [[200, 300], ...range(170, 100, 7).map((x) => [x, 300]), ...range(300, 320, 4).map((y) => [100, y])];
  drag(t, pts);
  assert.equal(t.coverage()[0].ranges.length, 0);
});

test('a second finger sliding onto the line is ignored while the first is tracing', () => {
  const t = createTracer([line]);
  t.pointerDown(1, 100, 100);
  t.pointerDown(2, 300, 480);                    // lands off the line
  for (const x of range(300, 100, 20)) t.pointerMove(2, x, 480);
  for (const y of range(480, 500, 5)) t.pointerMove(2, 100, y);
  assert.equal(t.activePointer, 1);
  assert.ok(!t.complete);
});

test('a fast move that crosses the start between two events still starts there (normal mode)', () => {
  const t = createTracer([line], { mode: 'normal' });
  const pts = [[100, 72], [100, 132], ...range(140, 500, 36).map((y) => [100, y])];   // lands 28 px above, skips the start
  assert.ok(drag(t, pts).some((e) => e.type === 'complete'));
});

// ---- Shapes: "free" (2026-11-23: either line of the cross first, the diagonal and the
// heart either way, the star from any corner) ----

const done = (ev) => ev.some((e) => e.type === 'complete');
const vbar = samplePath('M300 100 V500', 4), hbar = samplePath('M100 300 H500', 4);
const diag = samplePath('M400 75 L100 425', 4);
// The heart as in latin.json, at 5x: two lobes, each from the dip (50,34) down to the tip (50,88).
const lobeL = samplePath('M250 170 C195 40 50 60 50 185 C50 280 155 360 250 440', 4);
const lobeR = samplePath('M250 170 C305 40 450 60 450 185 C450 280 345 360 250 440', 4);
const STAR = [[250, 50], [380, 435], [45, 195], [455, 195], [120, 435]];   // as drawn, closing at the top
const star = samplePath(`M${STAR.map((p) => p.join(' ')).join(' L')} Z`, 4);
// Finger samples every 12 px along the given points (a real drag, not the stroke's own samples).
const walk = (...pts) => pts.slice(1).flatMap((b, i) => {
  const a = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 12));
  return range(0, 1, n).slice(i === 0 ? 0 : 1).map((t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
});
const along = (pts, k = 3) => pts.filter((_, i) => i % k === 0).concat([pts.at(-1)]);
const rev = (pts) => pts.slice().reverse();

test('free: either line of the cross first; in order otherwise', () => {
  for (const mode of ['easy', 'normal']) {
    const t = createTracer([vbar, hbar], { mode, free: true });
    drag(t, along(hbar));
    assert.equal(t.coverage()[1].done, true, mode);
    assert.equal(t.activeStroke, 0, mode);
    assert.ok(done(drag(t, along(vbar))), mode);
    const ordered = createTracer([vbar, hbar], { mode });
    drag(ordered, along(hbar));
    assert.ok(!ordered.coverage()[1].done, mode);
  }
});

test('free: a line from either end in normal mode too', () => {
  assert.ok(done(drag(createTracer([diag], { mode: 'normal', free: true }), along(rev(diag)))));
  assert.ok(!done(drag(createTracer([diag], { mode: 'normal' }), along(rev(diag)))));
});

test('free: the heart in one drag either way round, from the dip or the tip, or in two strokes', () => {
  const ways = {
    'anticlockwise from the dip': [...lobeL, ...rev(lobeR)],
    'clockwise from the dip': [...lobeR, ...rev(lobeL)],
    'from the tip, up the left': [...rev(lobeL), ...lobeR],
    'from the tip, up the right': [...rev(lobeR), ...lobeL],
  };
  for (const mode of ['easy', 'normal']) {
    for (const [name, pts] of Object.entries(ways)) {
      assert.ok(done(drag(createTracer([lobeL, lobeR], { mode, free: true }), along(pts))), `${mode}: ${name}`);
    }
    const t = createTracer([lobeL, lobeR], { mode, free: true });   // right lobe first, two strokes
    drag(t, along(lobeR));
    assert.ok(done(drag(t, along(lobeL))), `${mode}: right lobe, then left`);
  }
  // Not a shape: the left lobe has to come first.
  assert.ok(!done(drag(createTracer([lobeL, lobeR]), along([...lobeR, ...rev(lobeL)]))));
});

test('free: the stroke not being traced keeps none of the shared start', () => {
  // Both lobes leave the dip upwards, so the first few px are ambiguous; tracing the left lobe
  // must not leave ink at the start of the right one.
  const t = createTracer([lobeL, lobeR], { free: true });
  drag(t, along(lobeL));
  assert.equal(t.coverage()[0].done, true);
  // (The drag's tail may carry a sample or two onto the right lobe at the tip, where the left one
  // ends: carrying on is allowed. Nothing near the dip, though.)
  const near = t.coverage()[1].ranges.filter(([lo]) => lo < lobeR.length / 2);
  assert.deepEqual(near, []);
});

test('free: the star from every corner, either way round', () => {
  for (const mode of ['easy', 'normal']) {
    for (let c = 0; c < 5; c++) {
      for (const sign of [1, -1]) {
        const corners = Array.from({ length: 6 }, (_, j) => STAR[(((c + sign * j) % 5) + 5) % 5]);
        const ok = done(drag(createTracer([star], { mode, free: true }), walk(...corners)));
        assert.ok(ok, `${mode}, corner ${c}, ${sign > 0 ? 'as drawn' : 'backwards'}`);
      }
    }
  }
  // A common way: bottom left, up to the top.
  const t = createTracer([star], { mode: 'normal', free: true });
  assert.ok(done(drag(t, walk(STAR[4], STAR[0], STAR[1], STAR[2], STAR[3], STAR[4]))));
  // Not a shape (a closed letter or number): from the start dot only.
  assert.ok(!done(drag(createTracer([star], { mode: 'normal' }), walk(STAR[4], STAR[0], STAR[1], STAR[2], STAR[3], STAR[4]))));
});

test('free: a loop started past its seam shows progress on both sides of it, and survives a resize', () => {
  // The circle's samples start at the top. Start just left of the top and go clockwise past it.
  const around = (a0, a1) => range(a0, a1, 60).map((a) => [300 + 200 * Math.sin(a), 300 - 200 * Math.cos(a)]);
  const t = createTracer([circle], { mode: 'normal', free: true });
  drag(t, around(-0.6, 0.6));
  const ranges = t.coverage()[0].ranges;
  assert.equal(ranges.length, 2, JSON.stringify(ranges));
  assert.equal(ranges[0][1], circle.length - 1);
  assert.equal(ranges[1][0], 0);
  const big = samplePath('M600 200 C 820 200, 1000 380, 1000 600 C 1000 820, 820 1000, 600 1000 C 380 1000, 200 820, 200 600 C 200 380, 380 200, 600 200', 4);
  const t2 = createTracer([big], { mode: 'normal', free: true }, t.snapshot());
  const aroundBig = (a0, a1) => range(a0, a1, 160).map((a) => [600 + 400 * Math.sin(a), 600 - 400 * Math.cos(a)]);
  assert.ok(done(drag(t2, aroundBig(0.55, 2 * Math.PI - 0.6))), 'carries on from where it was, at the new size');
});

test('free: a tap on a loop, then a drag elsewhere on it, starts there', () => {
  const t = createTracer([circle], { free: true });
  t.pointerDown(1, 300, 100); t.pointerUp(1, 300, 100);
  const around = (a0) => range(a0, a0 - 2 * Math.PI, 140).map((a) => [300 + 200 * Math.sin(a), 300 - 200 * Math.cos(a)]);
  assert.ok(done(drag(t, around(Math.PI))));   // from the bottom, anticlockwise
});

test('free: a finger that leaves one stroke and traces another in the same touch gets both', () => {
  const t = createTracer([vbar, hbar], { free: true });
  const ev = drag(t, [...along(vbar.slice(0, 20)), ...walk([300, 176], [100, 300]), ...along(hbar)]);
  assert.equal(t.coverage()[1].done, true);
  assert.ok(!ev.some((e) => e.type === 'complete'));
  const [[lo, hi]] = t.coverage()[0].ranges;
  assert.ok(lo === 0 && hi >= 15, `kept the top of the vertical: ${lo}-${hi}`);
  assert.ok(done(drag(t, along(vbar.slice(15)))));
});

test('free: crossing the start of another stroke mid-trace leaves no ink on it', () => {
  // A T: the stem starts on the middle of the bar. Tracing the bar passes over the stem's start.
  const bar = samplePath('M100 100 H500', 4), stem = samplePath('M300 100 V500', 4);
  const t = createTracer([bar, stem], { free: true });
  drag(t, range(100, 440, 40).map((x) => [x, 100]));   // 85% of the bar: not finished yet
  assert.ok(!t.coverage()[0].done);
  assert.deepEqual(t.coverage()[1].ranges, []);
});

// ---- Codex review of the free shapes (2026-11-23) ----

const TOLS = { easy: 40, normal: 26 };

test('free: the star from just off a corner, on either edge, either way round', () => {
  for (const mode of ['easy', 'normal']) {
    const off = TOLS[mode] * 0.7;
    for (let c = 0; c < 5; c++) {
      for (const sign of [1, -1]) {
        const corners = Array.from({ length: 6 }, (_, j) => STAR[(((c + sign * j) % 5) + 5) % 5]);
        for (const edge of [1, 4]) {   // land on the edge to the next corner, or the one to the last
          const [a, b] = [corners[0], corners[edge]];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const land = [a[0] + ((b[0] - a[0]) * off) / L, a[1] + ((b[1] - a[1]) * off) / L];
          const t = createTracer([star], { mode, tolerance: TOLS[mode], free: true });
          const ok = done(drag(t, walk(land, ...corners.slice(1))));
          assert.ok(ok, `${mode}, corner ${c}, ${sign > 0 ? 'as drawn' : 'backwards'}, landing ${off.toFixed(0)} px along edge ${edge}`);
        }
      }
    }
  }
});

test('free: the star from its middle, where two edges cross, along either edge, either way', () => {
  const crossing = [250 + (130 * 145) / 385, 195];   // edge 0 (top to bottom right) crosses edge 2 (y=195)
  const laps = [
    [crossing, ...[1, 2, 3, 4, 0].map((j) => STAR[j]), crossing],    // along edge 0, as drawn
    [crossing, ...[0, 4, 3, 2, 1].map((j) => STAR[j]), crossing],    // along edge 0, backwards
    [crossing, ...[3, 4, 0, 1, 2].map((j) => STAR[j]), crossing],    // along edge 2, as drawn
    [crossing, ...[2, 1, 0, 4, 3].map((j) => STAR[j]), crossing],    // along edge 2, backwards
  ];
  for (const mode of ['easy', 'normal']) {
    for (const [i, lap] of laps.entries()) {
      assert.ok(done(drag(createTracer([star], { mode, tolerance: TOLS[mode], free: true }), walk(...lap))), `${mode}, lap ${i}`);
    }
  }
});

test('free: tracing one heart lobe leaves no ink on the other, at either tolerance or a little off', () => {
  for (const mode of ['easy', 'normal']) {
    for (const dx of [0, 5, -5]) {
      const t = createTracer([lobeL, lobeR], { mode, tolerance: TOLS[mode], free: true });
      drag(t, along(lobeL).map(([x, y]) => [x + dx, y]));
      assert.equal(t.coverage()[0].done, true, `${mode} ${dx}`);
      const near = t.coverage()[1].ranges.filter(([lo]) => lo < lobeR.length / 2);
      assert.deepEqual(near, [], `${mode}, ${dx} px off: ink at the dip`);
    }
  }
});

test('free: a later touch on the middle of the other lobe earns nothing from the dip', () => {
  const t = createTracer([lobeL, lobeR], { tolerance: 40, free: true });
  drag(t, along(lobeL));
  drag(t, walk([303, 101], [328, 88]));
  assert.deepEqual(t.coverage()[1].ranges.filter(([lo]) => lo < lobeR.length / 2), []);
});

test('free: the guide dot stays on the stroke he was on when he touches it again, or after a resize', () => {
  const t = createTracer([vbar, hbar], { free: true });
  drag(t, walk([300, 100], [300, 210]));
  drag(t, walk([100, 300], [210, 300]));
  const [dot] = t.startPoints();
  assert.ok(Math.abs(dot[1] - 300) < 1 && dot[0] > 180, `on the horizontal: ${dot}`);
  t.pointerDown(1, ...dot);
  assert.deepEqual(t.startPoints(), [dot]);
  t.pointerUp(1, ...dot);
  const t2 = createTracer([vbar, hbar], { free: true }, t.snapshot());
  assert.ok(Math.abs(t2.startPoints()[0][1] - 300) < 1);
});

test('free: a finger landing off a later stroke and sliding onto it picks that one up', () => {
  const t = createTracer([vbar, hbar], { free: true });
  drag(t, [[40, 300], [60, 300], [80, 300], ...along(hbar)]);   // lands 60 px left of the horizontal
  assert.equal(t.coverage()[1].done, true);
});

test('free: one trace over two strokes on the same path finishes one, cleanly; the next finishes both', () => {
  const a = samplePath('M0 0 H400', 4), b = samplePath('M0 0 H400', 4);
  const t = createTracer([a, b], { free: true });
  const lap = () => { t.pointerDown(1, 0, 0); for (const x of range(0, 360, 30)) t.pointerMove(1, x, 0); return t.pointerUp(1, 360, 0); };
  lap();
  assert.deepEqual(t.coverage().map((c) => c.done), [true, false]);
  assert.deepEqual(t.coverage()[1].ranges, [], 'the echo on the second is dropped, not left above the threshold');
  lap();
  assert.ok(t.complete);
});

test('free: a drag carried on from one stroke can start a loop wherever it reaches it', () => {
  const line2 = samplePath('M0 100 H200', 4), square = samplePath('M500 400 H800 V700 H500 Z', 4);
  const t = createTracer([line2, square], { free: true });
  // Finish the line, keep the finger down, come round to the square's bottom right corner from
  // outside it, and go round from there.
  const ev = drag(t, walk([0, 100], [200, 100], [900, 100], [900, 700], [800, 700], [500, 700], [500, 400], [800, 400], [800, 700]));
  assert.ok(done(ev));
});

test('free: a loop started part-way round is not drawn complete one sample early', () => {
  const square = samplePath('M100 100 H400 V400 H100 Z', 4);
  const n = square.length;
  const t = createTracer([square], { free: true, doneFraction: 1 });
  const start = square[55];
  const path = [...square.slice(55, n - 1), ...square.slice(0, 55)];   // round to one sample short
  drag(t, [start, ...path.slice(1)]);
  assert.ok(!t.complete);
  const ranges = t.coverage()[0].ranges;
  assert.ok(!ranges.some(([lo, hi]) => lo <= 54 && hi >= 55), JSON.stringify(ranges));
});

// ---- Codex recheck (2026-11-23): shapes at 500 px, origin (0,0), production tolerances ----

const LATIN = JSON.parse(fs.readFileSync(new URL('../../content/glyphs/latin.json', import.meta.url))).glyphs;
const shape = (name) => LATIN[name].strokes.map((d) => samplePath(d, 4 / 5).map(([x, y]) => [x * 5, y * 5]));
const tracer = (name, mode) => createTracer(shape(name), { mode, tolerance: TOLS[mode], step: 4, free: true });
const every3 = (pts) => pts.filter((_, i) => i % 3 === 0).concat([pts.at(-1)]);

test('free: a finger starting inside a corner, going to it and then down either side', () => {
  const t = tracer('star', 'easy');
  drag(t, walk([247, 77], [255, 65], [250, 50], [120, 435], [455, 195], [45, 195], [380, 435], [259, 77], [247, 77]));
  assert.ok(t.complete, 'star, into the top point and down the left side');
  const c = tracer('ice-cream', 'normal');
  drag(c, walk([380, 252], [392, 240], [400, 240], [250, 475], [100, 240], [400, 240], [380, 240]));
  assert.ok(c.coverage()[1].done, 'cone, from just under its rim to the corner and round');
});

test('free: finishing one stroke at a shared corner does not pin where the next loop starts', () => {
  for (const mode of ['easy', 'normal']) {
    const t = tracer('ice-cream', mode);
    drag(t, every3(shape('ice-cream')[0]).reverse().map(([x, y]) => [x, y + 10]));   // the scoop, right to left
    assert.ok(t.coverage()[0].done, mode);
    drag(t, walk([331, 348], [250, 475], [100, 240], [400, 240], [331, 348]));       // the cone, from its side
    assert.ok(t.complete, `${mode}: ice cream`);
    const b = tracer('balloon', mode);
    drag(b, every3(shape('balloon')[1]).reverse().map(([x, y]) => [x + 12, y - 8]));  // the string, upwards
    drag(b, along(shape('balloon')[0]));                                               // the body, from its top
    assert.ok(b.complete, `${mode}: balloon`);
  }
});

test('free: a short deliberate start on a circle survives a tap elsewhere', () => {
  const t = tracer('circle', 'easy');
  drag(t, walk([250, 60], [242, 60.2], [234, 61]));
  const before = t.coverage()[0].ranges;
  assert.ok(before.length, 'it counted');
  t.pointerDown(1, 250, 440); t.pointerUp(1, 250, 440);
  assert.deepEqual(t.coverage()[0].ranges, before);
});

test('free: lifting near the heart dip and finishing the lobe leaves no ink on the other lobe', () => {
  for (const mode of ['easy', 'normal']) {
    const t = tracer('heart', mode);
    const left = shape('heart')[0];
    const k = left.findIndex(([x, y]) => y < 150);
    drag(t, left.slice(0, k + 1));
    drag(t, left.slice(k));
    assert.ok(t.coverage()[0].done, mode);
    assert.deepEqual(t.coverage()[1].ranges.filter(([lo]) => lo < 20), [], `${mode}: ink at the dip`);
  }
});

test('free: the balloon string, stopped a fingertip short, still counts', () => {
  for (const mode of ['easy', 'normal']) {
    const t = tracer('balloon', mode);
    drag(t, every3(shape('balloon')[1]).map(([x, y]) => [x, y - 18]));
    drag(t, along(shape('balloon')[0]));
    assert.ok(t.complete, mode);
  }
});

test('free: two strokes finished by the same move both finish on it', () => {
  const a = samplePath('M0 0 H400', 4), b = samplePath('M0 60 H400', 4);
  const t = createTracer([a, b], { tolerance: 40, free: true });
  t.pointerDown(1, 0, 30);
  const ev = t.pointerMove(1, 359, 30);
  assert.equal(ev.filter((e) => e.type === 'strokeDone').length, 2);
  assert.ok(done(ev));
});
