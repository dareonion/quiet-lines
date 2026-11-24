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
// - "free" (shapes, in either mode): a shape has no handwriting order. Its strokes may be traced in
//   any order and from either end, and a closed one (circle, square, triangle, star) from wherever
//   the finger picks it up. Every untouched stroke (and every place a loop passes under the
//   finger) is a candidate, and the same rule picks one: ordered movement that puts it clearly
//   ahead of all the others. A little progress the others made in that touch (strokes sharing a
//   start) is dropped; more than that was real tracing, and stays.
// - A stroke is done at `doneFraction` of its samples; then the next stroke becomes active.
// - One active pointer: the first to land near the active stroke, or to slide onto it after
//   landing off it, until it lifts or is cancelled. Other touches (a resting palm, a second
//   finger) are ignored while it is down.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const MIN_DRAG = 8;

/**
 * @param {number[][][]} strokes  polylines, evenly spaced samples, in screen px
 * @param {{tolerance?:number, mode?:'easy'|'normal', free?:boolean, doneFraction?:number, step?:number, lookahead?:number}} opts
 * @param {object} [snap]  progress from snapshot(), to restore (e.g. after rotation)
 */
export function createTracer(strokes, opts = {}, snap = null) {
  const tolerance = opts.tolerance ?? 40;
  const mode = opts.mode ?? 'easy';
  const free = !!opts.free;
  const doneFraction = opts.doneFraction ?? 0.9;
  const step = opts.step ?? estimateStep(strokes);
  const lookahead = opts.lookahead ?? Math.max(tolerance * 1.5, 60);
  const window = Math.max(2, Math.ceil(lookahead / step));
  const commitLead = Math.max(2, Math.ceil((tolerance * 0.75) / step));
  const tailMax = Math.ceil((tolerance * 1.5) / step);   // a short start on a loop (samples)
  const nearPath = tolerance * 2.5;

  const both = mode === 'easy' || free;
  const fresh = (pts) => (both && pts.length > 1 ? [{ dir: 1, p: 0 }, { dir: -1, p: 0 }] : [{ dir: 1, p: 0 }]);
  // A loop (a closed stroke: its samples end where they start) can start anywhere, on a shape.
  const isLoop = (pts) => free && pts.length > 3 && dist(pts[0], pts[pts.length - 1]) <= step / 2;
  const state = strokes.map((pts, i) => {
    const saved = snap?.strokes?.[i];
    const m = pts.length - 1;
    return {
      pts,
      done: !!saved?.done,
      loop: isLoop(pts),
      cands: saved
        ? saved.cands.map((c) => ({ dir: c.dir, p: Math.round(c.frac * pts.length), rot: m > 0 ? Math.round((c.rot ?? 0) * m) % m : 0 }))
        : fresh(pts),
    };
  });
  const firstOpen = () => { const i = state.findIndex((s) => !s.done); return i < 0 ? state.length : i; };
  let active = firstOpen(); // the first stroke not done (in order, unless free)
  let focus = snap?.focus ?? null;   // free: the stroke last clearly traced (for the dots)
  let carried = false;      // this touch carried on from a stroke it finished
  let pointer = null;       // id of the active pointer
  const loose = new Map();  // pointers down but not (yet) on the line: id -> last point
  let last = null;          // last processed point of the active pointer
  let travel = 0;           // px the finger has moved since this stroke was picked up

  // The strokes a touch can be tracing: the next one in order, or (free) any not yet done.
  // (Free: all of them, all the time, so a finger that leaves one stroke and traces another in the
  // same touch gets that one too.)
  const field = () => (active >= state.length ? []
    : !free ? [active]
    : state.flatMap((s, i) => (s.done ? [] : [i])));

  // Sample k of candidate c's walk. A loop started part-way round (c.rot) wraps past its seam;
  // its last sample repeats its first, so the walk goes round its n - 1 distinct samples.
  const idx = (s, c, k) => {
    const n = s.pts.length;
    if (!c.rot) return c.dir === 1 ? k : n - 1 - k;
    const m = n - 1;
    return (((c.rot + c.dir * k) % m) + m) % m;
  };

  // Where a loop passes within reach of pt: the nearest sample of each separate stretch of it
  // in reach (two at a crossing, as in the star's middle), or that stretch's corner if one is in
  // reach. A finger landing near a star's point may be on either edge, or between them, and head
  // into the point before turning down one side: from the point itself, either way is open, and
  // going into it credits neither. (A corner just out of reach leaves a start on each edge, and
  // the turn decides between them.)
  function loopStarts(s, pt) {
    const m = s.pts.length - 1;
    const near = Array.from({ length: m }, (_, k) => dist(s.pts[k], pt) <= tolerance);
    if (!near.some(Boolean)) return [];
    if (near.every(Boolean)) return [nearestOf(s, pt, [...Array(m).keys()])];   // a tiny loop
    const from = near.findIndex((v) => !v);   // walk from a sample out of reach, so no run wraps
    const runs = [];
    let run = null;
    for (let j = 1; j <= m; j++) {
      const k = (from + j) % m;
      if (near[k]) (run ??= []).push(k);
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    const reach = Math.ceil((2 * tolerance) / step);
    const starts = runs.map((r) => {
      const at = nearestOf(s, pt, r);
      let corner = -1;
      for (let j = -reach; j <= reach; j++) {
        const k = (((at + j) % m) + m) % m;
        if (dist(s.pts[k], pt) <= tolerance && turn(s, k) >= CORNER && (corner < 0 || turn(s, k) > turn(s, corner))) corner = k;
      }
      return corner >= 0 ? corner : at;
    });
    return [...new Set(starts)];
  }
  const nearestOf = (s, pt, ks) => ks.reduce((b, k) => (dist(s.pts[k], pt) < dist(s.pts[b], pt) ? k : b));
  // How sharply a loop turns at sample k (radians), over a few samples either side.
  const CORNER = Math.PI / 4;
  function turn(s, k) {
    const m = s.pts.length - 1, w = 3;
    const a = s.pts[(k - w + m) % m], b = s.pts[k], c = s.pts[(k + w) % m];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (!lu || !lv) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv))));
  }
  // An untouched loop starts where the finger meets it (on touchdown, sliding on, or carried on
  // from another stroke), going either way, unless a start it already has is under the finger.
  // A loop with only a short start on it and no way round chosen yet (the end of a drag carried
  // on from another stroke, or a brief first try) also gets starts where a fresh touch lands. Its
  // progress stays until the finger shows which it is continuing: the commit rule decides.
  function startLoop(s, pt, freshTouch = false) {
    if (!s.loop) return;
    const untouched = s.cands.every((c) => c.p === 0);
    const short = freshTouch && s.cands.length > 1 && s.cands.every((c) => c.p <= tailMax);
    if (!untouched && !short) return;
    const at = (c, k) => s.pts[idx(s, c, Math.min(k, s.pts.length - 1))];
    if (s.cands.some((c) => c.rot !== undefined && (dist(at(c, 0), pt) <= tolerance || dist(at(c, c.p), pt) <= tolerance))) return;
    const starts = loopStarts(s, pt);
    if (!starts.length) return;
    // Armed: a start is put where the finger is.
    s.cands = [...s.cands.filter((c) => c.p > 0), ...starts.flatMap((rot) => [1, -1].map((dir) => (
      { dir, p: 0, p0: 0, stall: 0, rot, armed: true })))];
  }

  function pickUp(pt, isCarried) {
    travel = 0;
    carried = isCarried;
    for (const i of field()) {
      const s = state[i];
      for (const c of s.cands) {
        c.p0 = c.p;
        c.stall = 0;
        // Free: a stroke he hasn't started is eligible only from a start this touch reaches (a
        // shape's other strokes are near the finger all the time; that mustn't carry over).
        if (free && c.p === 0) c.armed = false;
        if (pt && c.p === 0 && dist(s.pts[idx(s, c, 0)], pt) <= tolerance) c.armed = true;
      }
      if (pt) startLoop(s, pt, !isCarried);
    }
  }

  function nearStroke(s, pt) {
    return s.pts.some((q) => dist(q, pt) <= tolerance);
  }
  // Near a stroke a fresh touch could pick up (any not done, if free).
  const nearOpen = (pt) => (free ? state.some((s) => !s.done && nearStroke(s, pt))
    : active < state.length && nearStroke(state[active], pt));

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
    const strokesNow = field();
    if (!strokesNow.length) return;
    for (const i of strokesNow) {
      startLoop(state[i], pt);
      advanceStroke(state[i], pt, mv, moved);
    }
    // Commit: once one candidate (a direction, and with free, a stroke) has gained clearly more
    // than every other in THIS touch, the others drop out. Progress left by a carried tail
    // mustn't count as a lead.
    const all = strokesNow.flatMap((i) => state[i].cands.map((c) => ({ i, c })));
    const gain = ({ c }) => c.p - (c.p0 ?? 0);
    if (all.length > 1 && !carried) {
      const top = all.reduce((m, x) => (gain(x) > gain(m) ? x : m));
      if (all.every((x) => x === top || gain(top) - gain(x) >= commitLead)) choose(strokesNow, top);
    }
    // A stroke can also finish before any candidate commits (short strokes, carried drags):
    // whichever reaches the threshold first wins. (Free: two can finish on one move.)
    for (let more = true; more && active < state.length;) {
      more = false;
      for (const i of field()) {
        const s = state[i];
        const lead = s.cands.reduce((m, c) => (c.p > m.p ? c : m));
        if (lead.p < Math.ceil(doneFraction * s.pts.length)) continue;
        choose(field(), { i, c: lead });
        s.done = true;
        events.push({ type: 'strokeDone', index: i });
        active = firstOpen();
        if (active >= state.length) events.push({ type: 'complete' });
        else { pickUp(pt, true); more = free; }  // the same finger can carry straight on into the next stroke
        break;
      }
    }
  }

  // Keep candidate `top`: its stroke's other candidates go. The other strokes in play lose what
  // lies along the winner's own path (where strokes share a start, the first px count for both),
  // but keep real tracing elsewhere (part of one stroke, then on to another). For a stroke with
  // a way chosen, that's what this touch gave it; for one without, all it has (an echo left by an
  // earlier touch that lifted before anything was clear).
  function choose(strokesNow, top) {
    const ts = state[top.i];
    const onWinner = (q) => {
      for (let k = 0; k < top.c.p; k++) if (dist(ts.pts[idx(ts, top.c, k)], q) <= tolerance) return true;
      return false;
    };
    for (const j of strokesNow) {
      if (j === top.i) continue;
      const s = state[j];
      for (const c of s.cands) {
        const from = s.cands.length > 1 ? 0 : (c.p0 ?? c.p);
        if (c.p <= from) continue;
        let echo = true;
        for (let k = from; k < c.p && echo; k++) echo = onWinner(s.pts[idx(s, c, k)]);
        if (!echo) continue;
        c.p = from;
        c.p0 = Math.min(c.p0 ?? from, from);
      }
    }
    ts.cands = [top.c];
    if (free) focus = top.i;
  }

  function advanceStroke(s, pt, mv, moved) {
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

  // The stroke the dots are for: in order, the next one; free, the one being traced, else one
  // already started, else the first left.
  function shown() {
    if (!free || active >= state.length) return active;
    if (focus !== null && !state[focus].done) return focus;
    const started = state.findIndex((s) => !s.done && s.cands.some((c) => c.p > 0));
    return started >= 0 ? started : active;
  }

  return {
    /** Picks the stroke up if near it. Credits nothing: progress needs movement. */
    pointerDown(id, x, y) {
      if (active >= state.length) return [];
      const pt = [x, y];
      if (pointer !== null || !nearOpen(pt)) { loose.set(id, pt); return []; }
      pointer = id;
      last = pt;
      pickUp(pt, false);
      return [];
    },
    pointerMove(id, x, y) {
      const events = [];
      if (active >= state.length) return events;
      const pt = [x, y];
      // A finger that landed just off the line and slides onto it is picked up where it arrives
      // (as if it had landed there), so a small miss at touchdown doesn't cost the whole drag. The
      // move is walked in half-steps, so a fast one crossing the start still starts there.
      if (pointer === null && loose.has(id)) {
        const from = loose.get(id);
        const d = dist(from, pt), n = Math.max(1, Math.ceil(d / (step / 2)));
        for (let i = 1; i <= n; i++) {
          const q = [from[0] + ((pt[0] - from[0]) * i) / n, from[1] + ((pt[1] - from[1]) * i) / n];
          if (!nearOpen(q)) continue;
          loose.delete(id);
          pointer = id;
          last = q;
          pickUp(q, false);
          processSegment(q, pt, events);
          last = pt;
          return events;
        }
        loose.set(id, pt);
        return events;
      }
      if (id !== pointer) {
        if (loose.has(id)) loose.set(id, pt);
        return events;
      }
      processSegment(last, pt, events);
      last = pt;
      return events;
    },
    /** Lift: the final position still counts (it can be past the last move event). */
    pointerUp(id, x, y) {
      let events = [];
      if (id === pointer && x !== undefined) events = this.pointerMove(id, x, y);
      if (id === pointer) { pointer = null; last = null; }
      loose.delete(id);
      return events;
    },
    /** Cancel (system gesture, rotation): release without counting the position. */
    pointerCancel(id) {
      if (id === pointer) { pointer = null; last = null; }
      loose.delete(id);
      return [];
    },
    get activePointer() { return pointer; },
    get activeStroke() { return shown(); },
    get complete() { return active >= state.length; },
    /** Progress as fractions, independent of screen size (restore with createTracer(..., snap)). */
    snapshot() {
      return {
        focus,
        strokes: state.map((s) => ({
          done: s.done,
          cands: s.cands.map((c) => ({ dir: c.dir, frac: c.p / s.pts.length, rot: c.rot ? c.rot / (s.pts.length - 1) : 0 })),
        })),
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
          if (!c.rot) { ranges.push([Math.min(a, b), Math.max(a, b)]); continue; }
          // Part-way round a loop: from lo forwards to hi, split where it crosses the seam.
          const n = s.pts.length;
          if (c.p >= n) { ranges.push([0, n - 1]); continue; }
          const [lo, hi] = c.dir === 1 ? [a, b] : [b, a];
          if (lo <= hi) ranges.push([lo, hi]);
          else ranges.push([lo, n - 1], [0, hi]);
        }
        return { done: false, ranges };
      });
    },
    /** Where to show the "start here" dot(s) for the active stroke. */
    startPoints() {
      const s = state[shown()];
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
