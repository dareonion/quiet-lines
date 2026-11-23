// Turns an SVG path string into a polyline. Pure (no DOM) so node:test can exercise it.
// Supports M L H V C Q Z, absolute and relative: enough for hand-authored glyph strokes.

const TOKEN = /([MLHVCQZmlhvcqz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;

function tokenize(d) {
  const out = [];
  for (const m of d.matchAll(TOKEN)) out.push(m[1] ?? Number(m[2]));
  return out;
}

/** Parse into absolute segments: {type:'M'|'L'|'C'|'Q', pts:[[x,y],...]} */
export function parsePath(d) {
  const t = tokenize(d);
  const segs = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
  const num = () => {
    if (typeof t[i] !== 'number') throw new Error(`bad path near token ${i}: ${d}`);
    return t[i++];
  };
  while (i < t.length) {
    if (typeof t[i] === 'string') cmd = t[i++];
    else if (cmd === null) throw new Error(`path must start with a command: ${d}`);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === 'M') {
      cx = ox + num(); cy = oy + num(); sx = cx; sy = cy;
      segs.push({ type: 'M', pts: [[cx, cy]] });
      cmd = rel ? 'l' : 'L'; // implicit lineto after moveto
    } else if (C === 'L') {
      cx = ox + num(); cy = oy + num();
      segs.push({ type: 'L', pts: [[cx, cy]] });
    } else if (C === 'H') {
      cx = (rel ? cx : 0) + num();
      segs.push({ type: 'L', pts: [[cx, cy]] });
    } else if (C === 'V') {
      cy = (rel ? cy : 0) + num();
      segs.push({ type: 'L', pts: [[cx, cy]] });
    } else if (C === 'C') {
      const p1 = [ox + num(), oy + num()], p2 = [ox + num(), oy + num()], p = [ox + num(), oy + num()];
      segs.push({ type: 'C', pts: [p1, p2, p] });
      [cx, cy] = p;
    } else if (C === 'Q') {
      const p1 = [ox + num(), oy + num()], p = [ox + num(), oy + num()];
      segs.push({ type: 'Q', pts: [p1, p] });
      [cx, cy] = p;
    } else if (C === 'Z') {
      cx = sx; cy = sy;
      segs.push({ type: 'L', pts: [[cx, cy]] });
      cmd = null;
    } else {
      throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return segs;
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function curvePoint(type, p0, pts, t) {
  if (type === 'Q') {
    const [p1, p2] = pts;
    return lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
  }
  const [p1, p2, p3] = pts;
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

/** Dense polyline (fine steps), then resampled to even spacing `step` (same units as the path). */
export function samplePath(d, step = 1) {
  const segs = parsePath(d);
  const dense = [];
  let cur = null;
  for (const s of segs) {
    if (s.type === 'M') {
      if (dense.length) throw new Error(`one stroke per path (no second M): ${d}`);
      cur = s.pts[0];
      dense.push(cur);
    } else if (s.type === 'L') {
      dense.push(s.pts[0]);
      cur = s.pts[0];
    } else {
      for (let k = 1; k <= 32; k++) dense.push(curvePoint(s.type, cur, s.pts, k / 32));
      cur = s.pts[s.pts.length - 1];
    }
  }
  return resample(dense, step);
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Even spacing along the polyline; always keeps both endpoints. */
export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg === 0) continue;
    let pos = step - carry;
    while (pos <= seg) {
      out.push(lerp(a, b, pos / seg));
      pos += step;
    }
    carry = seg - (pos - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}
