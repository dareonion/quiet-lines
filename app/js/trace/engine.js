// Tracing engine: pure logic, no DOM. Coordinates are screen pixels.
//
// Rules (CLAUDE.md, plan "Tracing engine"; hardened by three Codex reviews):
// - Strokes are polylines resampled at even spacing. Tolerance is in screen points (about a
//   fingertip), not a fraction of the glyph, so short strokes aren't swallowed.
// - Progress comes from MOVEMENT only. Touching down picks the stroke up but credits nothing, and
//   nothing is credited until the finger has dragged MIN_DRAG px (so taps, even jittery ones, never
//   advance it). Each move credits up to the stroke sample NEAREST the finger (within tolerance),
//   searched in a window around the frontier, and progress within one gesture is capped at 1.5x
//   the finger's travel (fingers cut corners). Lifting keeps progress.
// - Only movement ALONG the stroke counts: a move earns credit only if it goes the stroke's way at
//   that point: within about 105 degrees of the path's direction there, smoothed over a fingertip
//   either side, so cutting a corner still counts. Moving backwards over the line, or toward the
//   frontier from beyond it, earns nothing.
// - Cutting a sharp corner (a star's points) can leave the finger out of reach of the samples just
//   ahead. While the finger keeps moving near the path, the stroke's way, without progress, the
//   look-ahead window grows with that movement, so it can pick the outgoing side up again.
//   Wandering away or moving against the stroke resets it.
// - "easy": a stroke may be traced from either end. A direction is only eligible once the finger
//   has been within tolerance of that direction's own start (on touchdown or while moving). Both
//   stay candidates until ordered movement puts one clearly ahead. After a stroke finishes in the
//   middle of a drag, the same drag can carry on into the next stroke, but can't commit its
//   direction: that waits for a fresh touch, so a stray tail never locks the wrong way.
//   "normal": forward only.
// - A stroke is done at `doneFraction` of its samples; then the next stroke becomes active.
// - One active pointer: the first to land near the active stroke, until it lifts or is
//   cancelled. Other touches (a resting palm, a second finger) are ignored.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const MIN_DRAG = 8;

/**
 * @param {number[][][]} strokes  polylines, evenly spaced samples, in screen px
 * @param {{tolerance?:number, mode?:'easy'|'normal', doneFraction?:number, step?:number, lookahead?:number}} opts
 * @param {object} [snap]  progress from snapshot(), to restore (e.g. after rotation)
 */
export function createTracer(strokes, opts = {}, snap = null) {
  const tolerance = opts.tolerance ?? 40;
  const mode = opts.mode ?? 'easy';
  const doneFraction = opts.doneFraction ?? 0.9;
  const step = opts.step ?? estimateStep(strokes);
  const lookahead = opts.lookahead ?? Math.max(tolerance * 1.5, 60);
  const window = Math.max(2, Math.ceil(lookahead / step));
  const commitLead = Math.max(2, Math.ceil((tolerance * 0.75) / step));
  const nearPath = tolerance * 2.5;

  const fresh = (pts) => (mode === 'easy' && pts.length > 1 ? [{ dir: 1, p: 0 }, { dir: -1, p: 0 }] : [{ dir: 1, p: 0 }]);
  const state = strokes.map((pts, i) => {
    const saved = snap?.strokes?.[i];
    return {
      pts,
      done: !!saved?.done,
      carried: false,
      cands: saved ? saved.cands.map((c) => ({ dir: c.dir, p: Math.round(c.frac * pts.length) })) : fresh(pts),
    };
  });
  let active = snap ? Math.min(snap.active, state.length) : 0;
  let pointer = null;       // id of the active pointer
  let last = null;          // last processed point of the active pointer
  let travel = 0;           // px the finger has moved since this stroke was picked up

  const idx = (s, c, k) => (c.dir === 1 ? k : s.pts.length - 1 - k);

  function pickUp(pt, carried) {
    travel = 0;
    const s = state[active];
    if (!s) return;
    s.carried = carried;
    for (const c of s.cands) {
      c.p0 = c.p;
      c.stall = 0;
      if (pt && c.p === 0 && dist(s.pts[idx(s, c, 0)], pt) <= tolerance) c.armed = true;
    }
  }

  function nearStroke(s, pt) {
    return s.pts.some((q) => dist(q, pt) <= tolerance);
  }

  // Is a move "along" the stroke near sample k (walking in candidate c's direction)? The stroke's
  // direction is measured over a fingertip on each side of k: just before it and just after it.
  // At a corner those differ, and a move that matches either side counts (a finger rounding a
  // star's point, or B's middle, is heading for the outgoing side).
  const span = Math.max(1, Math.round(tolerance / step));
  const ALONG = -0.26;   // cos(105 degrees)
  function along(s, c, k, mv, moved) {
    const n = s.pts.length;
    const at = (j) => s.pts[idx(s, c, Math.min(n - 1, Math.max(0, j)))];
    for (const [a, b] of [[at(k - span), at(k)], [at(k), at(k + span)], [at(k - span), at(k + span)]]) {
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty);
      if (tl > 0 && (tx * mv[0] + ty * mv[1]) / (tl * moved) > ALONG) return true;
    }
    return false;
  }

  function advance(pt, mv, events) {
    const moved = Math.hypot(mv[0], mv[1]);
    const s = state[active];
    if (!s || s.done) return;
    const n = s.pts.length;
    for (const c of s.cands) {
      // A direction only becomes eligible at its own start point.
      if (c.p === 0 && !c.armed) {
        if (dist(s.pts[idx(s, c, 0)], pt) > tolerance) continue;
        c.armed = true;
      }
      const ahead = window + Math.ceil((c.stall * 1.5) / step);
      let best = -1, bestD = Infinity;
      for (let k = Math.max(0, c.p - window); k < Math.min(n, c.p + ahead); k++) {
        const d = dist(s.pts[idx(s, c, k)], pt);
        if (d < bestD) { bestD = d; best = k; }
      }
      const isAlong = best >= 0 && moved > 0 && along(s, c, best, mv, moved);
      // Near the path, moving its way, but not progressing (a cut corner): let the window grow.
      // Off the path (wandering, scribbling) or against it: no growth.
      c.stall = bestD <= nearPath && isAlong ? c.stall + moved : 0;
      if (travel < MIN_DRAG || !isAlong) continue;
      // n samples span n-1 steps: the very first sample of a stroke needs no travel. Only at
      // the start, so a row of slightly jittery taps can't creep forward one sample each.
      const cap = c.p0 + Math.floor((travel * 1.5) / step) + (c.p0 === 0 ? 1 : 0);
      if (best >= 0 && bestD <= tolerance && best + 1 > c.p) {
        const next = Math.min(best + 1, Math.max(c.p, cap));
        if (next > c.p) { c.p = next; c.stall = 0; }
      }
    }
    if (s.cands.length === 2 && !s.carried) {
      // Compare what each direction gained in THIS touch: progress left by a carried tail
      // mustn't count as a lead.
      const [a, b] = s.cands;
      const ga = a.p - (a.p0 ?? 0), gb = b.p - (b.p0 ?? 0);
      if (ga - gb >= commitLead) s.cands = [a];
      else if (gb - ga >= commitLead) s.cands = [b];
    }
    // A stroke can also finish before either direction commits (short strokes, carried drags):
    // whichever candidate reaches the threshold first wins.
    const lead = s.cands.reduce((m, c) => (c.p > m.p ? c : m));
    if (lead.p >= Math.ceil(doneFraction * n)) {
      s.cands = [lead];
      s.done = true;
      events.push({ type: 'strokeDone', index: active });
      active += 1;
      if (active >= state.length) events.push({ type: 'complete' });
      else pickUp(pt, true); // the same finger can carry straight on into the next stroke
    }
  }

  function processSegment(from, to, events) {
    // Fast swipes give sparse pointer events: walk the segment in half-steps.
    const d = dist(from, to);
    if (d === 0) return;   // no movement, no credit (a lift where it landed is a tap)
    const n = Math.max(1, Math.ceil(d / (step / 2)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      travel += d / n;
      advance([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
        [(to[0] - from[0]) / n, (to[1] - from[1]) / n], events);
      if (active >= state.length) break;
    }
  }

  return {
    /** Picks the stroke up if near it. Credits nothing: progress needs movement. */
    pointerDown(id, x, y) {
      if (pointer !== null || active >= state.length) return [];
      const pt = [x, y];
      if (!nearStroke(state[active], pt)) return [];
      pointer = id;
      last = pt;
      pickUp(pt, false);
      return [];
    },
    pointerMove(id, x, y) {
      const events = [];
      if (id !== pointer || active >= state.length) return events;
      const pt = [x, y];
      processSegment(last, pt, events);
      last = pt;
      return events;
    },
    /** Lift: the final position still counts (it can be past the last move event). */
    pointerUp(id, x, y) {
      let events = [];
      if (id === pointer && x !== undefined) events = this.pointerMove(id, x, y);
      if (id === pointer) { pointer = null; last = null; }
      return events;
    },
    /** Cancel (system gesture, rotation): release without counting the position. */
    pointerCancel(id) {
      if (id === pointer) { pointer = null; last = null; }
      return [];
    },
    get activePointer() { return pointer; },
    get activeStroke() { return active; },
    get complete() { return active >= state.length; },
    /** Progress as fractions, independent of screen size (restore with createTracer(..., snap)). */
    snapshot() {
      return {
        active,
        strokes: state.map((s) => ({ done: s.done, cands: s.cands.map((c) => ({ dir: c.dir, frac: c.p / s.pts.length })) })),
      };
    },
    /** For rendering: per stroke, the covered sample index ranges [lo, hi] (inclusive). */
    coverage() {
      return state.map((s) => {
        if (s.done) return { done: true, ranges: [[0, s.pts.length - 1]] };
        const ranges = [];
        for (const c of s.cands) {
          if (c.p === 0) continue;
          const a = idx(s, c, 0), b = idx(s, c, c.p - 1);
          ranges.push([Math.min(a, b), Math.max(a, b)]);
        }
        return { done: false, ranges };
      });
    },
    /** Where to show the "start here" dot(s) for the active stroke. */
    startPoints() {
      const s = state[active];
      if (!s) return [];
      // Untouched: one dot at the canonical start (two dots on a line would confuse him).
      if (s.cands.every((c) => c.p === 0)) return [s.pts[0]];
      return s.cands.filter((c) => c.p > 0).map((c) => s.pts[idx(s, c, Math.min(c.p, s.pts.length - 1))]);
    },
  };
}

function estimateStep(strokes) {
  for (const pts of strokes) if (pts.length > 1) return Math.max(1, dist(pts[0], pts[1]));
  return 4;
}
