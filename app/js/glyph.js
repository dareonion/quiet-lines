// One source of truth for how a glyph looks: cards, pickers and the trace guide all draw from the
// same stroke data, so what he sees on a card is exactly what he traces (plan: Chinese glyphs come
// from outline data, never a system font).
//
// Glyph refs: "latin:<name>" (latin.json: SVG path strokes in a 100 box, y down) or
// "hanzi:<char>" (hanzi-writer-data: filled outlines + medians in a 1024 box, y up, y_screen = 900 - y).

import { samplePath, resample } from './trace/path.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function hanziFile(char) {
  return `content/glyphs/hanzi/${char.codePointAt(0).toString(16)}.json`;
}

/** Load every glyph the catalog references. Everything is precached, so this works offline. */
export async function loadGlyphs(catalog) {
  const latin = await fetch('content/glyphs/latin.json').then((r) => { if (!r.ok) throw new Error(`latin: ${r.status}`); return r.json(); });
  const chars = [...new Set(catalog.items.map((i) => i.glyph).filter((g) => g?.startsWith('hanzi:')).map((g) => g.slice(6)))];
  const hanzi = {};
  // All or nothing: a half-loaded set would show cards and lessons with holes in them. The caller
  // retries (from the offline copy, once it's installed).
  await Promise.all(chars.map(async (ch) => {
    const r = await fetch(hanziFile(ch));
    if (!r.ok) throw new Error(`glyph ${ch}: ${r.status}`);
    hanzi[ch] = await r.json();
  }));
  return { latin, hanzi };
}

/** Parse a glyph ref into a drawable description, or null if its data is missing. */
export function resolveGlyph(ref, glyphs) {
  if (!ref) return null;
  const [set, ...rest] = ref.split(':');
  const name = rest.join(':');
  if (set === 'latin') {
    const g = glyphs.latin.glyphs[name];
    return g ? { kind: 'latin', box: glyphs.latin.box, strokes: g.strokes } : null;
  }
  if (set === 'hanzi') {
    const g = glyphs.hanzi[name];
    return g ? { kind: 'hanzi', box: g.box, yFlip: g.y_flip, outlines: g.strokes, medians: g.medians } : null;
  }
  return null;
}

/** SVG markup for a glyph (static: tiles and cards). */
export function glyphSVG(ref, glyphs, { color = 'currentColor', label = '' } = {}) {
  const g = resolveGlyph(ref, glyphs);
  const aria = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  if (!g) return '';
  if (g.kind === 'latin') {
    const w = g.box * 0.085;
    return `<svg class="glyph-svg" viewBox="0 0 ${g.box} ${g.box}" ${aria}>` +
      g.strokes.map((d) => `<path d="${esc(d)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`).join('') +
      '</svg>';
  }
  return `<svg class="glyph-svg" viewBox="0 0 ${g.box} ${g.box}" ${aria}><g transform="translate(0, ${g.yFlip}) scale(1, -1)">` +
    g.outlines.map((d) => `<path d="${esc(d)}" fill="${color}"/>`).join('') +
    '</g></svg>';
}

/**
 * Screen geometry for tracing: polylines (evenly resampled at `step` px) plus a guide painter.
 * @returns {{strokePts: number[][][], drawGuide: (ctx, style) => void, drawFilled: (ctx, style) => void, lineWidth: number}}
 */
export function layoutGlyph(g, { ox, oy, side, step = 4 }) {
  const scale = side / g.box;
  if (g.kind === 'latin') {
    const strokePts = g.strokes.map((d) => samplePath(d, step / scale).map(([x, y]) => [ox + x * scale, oy + y * scale]));
    return { kind: 'latin', strokePts, lineWidth: Math.max(34, side * 0.075) };
  }
  const toScreen = ([x, y]) => [ox + x * scale, oy + (g.yFlip - y) * scale];
  const strokePts = g.medians.map((m) => resample(m.map(toScreen), step));
  const paths = g.outlines.map((d) => new Path2D(d));
  const withTransform = (ctx, fn) => {
    ctx.save();
    ctx.transform(scale, 0, 0, -scale, ox, oy + g.yFlip * scale);
    fn();
    ctx.restore();
  };
  return {
    kind: 'hanzi',
    strokePts,
    // A median line this wide covers the outline's body, so progress reads as "filling in".
    lineWidth: Math.max(22, side * 0.075),
    /** Fill outlines (all, or only `which` stroke indexes). */
    fillOutlines(ctx, color, which = null) {
      withTransform(ctx, () => {
        ctx.fillStyle = color;
        paths.forEach((p, i) => { if (!which || which.includes(i)) ctx.fill(p); });
      });
    },
    /** Clip to one stroke's outline (so progress paint stays inside the brush shape). */
    clipTo(ctx, i) {
      ctx.save();
      ctx.transform(scale, 0, 0, -scale, ox, oy + g.yFlip * scale);
      ctx.clip(paths[i]);
      ctx.setTransform(...currentDpr(ctx));
    },
  };
}

function currentDpr(ctx) {
  const dpr = ctx.canvas.width / ctx.canvas.getBoundingClientRect().width || 1;
  return [dpr, 0, 0, dpr, 0, 0];
}
