import { icons } from '../icons.js';
import { playSequence, silence } from '../audio.js';
import { clipsToSay, getSettings } from '../settings.js';
import { TraceSurface } from '../trace/surface.js';
import { resolveGlyph } from '../glyph.js';

/** Trace screen: the glyph's faint guide, a start dot, Home, back, and Start over. */
export function renderTrace(root, { item, glyphs, go }) {
  const glyph = resolveGlyph(item.glyph, glyphs);
  const back = `#/card/${item.id}`;
  const el = document.createElement('section');
  el.className = 'screen trace';
  el.innerHTML = `
    <div class="bar">
      <div class="bar-group">
        <button class="round" data-act="home" aria-label="Home">${icons.home}</button>
        <button class="round" data-act="back" aria-label="Back">${icons.back}</button>
      </div>
      <button class="round" data-act="restart" aria-label="Start over">${icons.restart}</button>
    </div>
    <div class="trace-stage"><canvas></canvas></div>`;
  root.append(el);
  el.querySelector('[data-act="home"]').addEventListener('click', () => go('#/'));
  el.querySelector('[data-act="back"]').addEventListener('click', () => go(back));
  if (!glyph) return () => {};
  const surface = new TraceSurface(el.querySelector('canvas'), glyph, {
    mode: getSettings().ease,
    free: item.kind === 'shape',   // shapes have no handwriting order or direction
    onComplete: () => playSequence(clipsToSay(item)),
  });
  el.querySelector('[data-act="restart"]').addEventListener('click', () => { silence(); surface.restart(); });
  // Exposed for the Playwright tests (scripted traces read the stroke geometry).
  window.__trace = surface;
  return () => { silence(); surface.destroy(); if (window.__trace === surface) window.__trace = null; };
}
