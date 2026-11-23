import { icons } from '../icons.js';
import { AREAS, PAGE, itemsOf, itemHash } from '../areas.js';
import { glyphSVG } from '../glyph.js';

/** A page of six items, with big prev/next arrows where there's more. Nothing to read. */
export function renderPicker(root, { catalog, glyphs, go, areaId, page }) {
  const area = AREAS.find((a) => a.id === areaId);
  const items = itemsOf(catalog, area.kind);
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const el = document.createElement('section');
  el.className = `screen picker picker-${area.id}`;
  el.innerHTML = `
    <div class="bar">
      <button class="round" data-act="home" aria-label="Home">${icons.home}</button>
      <span></span>
    </div>
    <div class="picker-body">
      <button class="round arrow" data-act="prev" aria-label="Back a page" ${p === 0 ? 'hidden' : ''}>${icons.prev}</button>
      <div class="picker-grid"></div>
      <button class="round arrow" data-act="next" aria-label="Next page" ${p >= pages - 1 ? 'hidden' : ''}>${icons.next}</button>
    </div>`;
  const grid = el.querySelector('.picker-grid');
  for (const item of items.slice(p * PAGE, p * PAGE + PAGE)) {
    const b = document.createElement('button');
    b.className = 'tile item-tile';
    b.dataset.item = item.id;
    b.setAttribute('aria-label', item.label?.en || item.word || item.text || item.id);
    b.innerHTML = glyphSVG(item.glyph, glyphs) || `<span class="glyph">${item.text ?? ''}</span>`;
    b.addEventListener('click', () => go(itemHash(item)));
    grid.append(b);
  }
  el.querySelector('[data-act="home"]').addEventListener('click', () => go('#/'));
  el.querySelector('[data-act="prev"]').addEventListener('click', () => go(`#/area/${area.id}/${p - 1}`));
  el.querySelector('[data-act="next"]').addEventListener('click', () => go(`#/area/${area.id}/${p + 1}`));
  root.append(el);
  return () => {};
}
