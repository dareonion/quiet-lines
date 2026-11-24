import { icons } from '../icons.js';
import { hasClip, playSequence, silence } from '../audio.js';
import { clipsToSay, countClips, countDoneClips } from '../settings.js';
import { pickerHashFor } from '../areas.js';
import { glyphSVG } from '../glyph.js';

/**
 * Item card. Nothing plays until he taps:
 * - the big glyph says its name (numbers: in the chosen language(s));
 * - the picture says its word (letters) or its name (中文);
 * - numbers show a ten-frame to count instead of a picture (plan, "Counting").
 * Home, back to the list, and (where there is one) the trace button are always there.
 */
export function renderCard(root, { item, catalog, glyphs, go }) {
  // Zero has an empty frame: nothing to count again, so no button that does nothing.
  const recount = item.kind === 'number' && countOf(item) > 0;
  const el = document.createElement('section');
  el.className = `screen card card-${item.kind}`;
  el.innerHTML = `
    <div class="bar">
      <div class="bar-group">
        <button class="round" data-act="home" aria-label="Home">${icons.home}</button>
        <button class="round" data-act="back" aria-label="Back to the list">${icons.back}</button>
      </div>
      <div class="bar-group">
        ${recount ? `<button class="round" data-act="recount" aria-label="Count again">${icons.restart}</button>` : ''}
        ${item.trace ? `<button class="round trace-btn" data-act="trace" aria-label="Trace it">${icons.trace}</button>` : ''}
      </div>
    </div>
    <div class="card-body">
      <button class="card-glyph" data-act="say" aria-label="${item.label?.en || item.text || ''}"></button>
      <div class="card-picture"></div>
    </div>`;
  const glyphBtn = el.querySelector('[data-act="say"]');
  glyphBtn.innerHTML = glyphSVG(item.glyph, glyphs) || `<span class="glyph-text">${item.text ?? ''}</span>`;
  // A quick second tap interrupts the first clip: only the latest tap's clip clears the highlight.
  let speaking = 0;
  const speak = async (btn, ids) => {
    const mine = ++speaking;
    el.querySelectorAll('.speaking').forEach((b) => b.classList.remove('speaking'));   // the other button's clip stopped
    btn.classList.add('speaking');
    await playSequence(ids);
    if (mine === speaking) btn.classList.remove('speaking');
  };
  glyphBtn.addEventListener('click', () => speak(glyphBtn, clipsToSay(item)));

  const picture = el.querySelector('.card-picture');
  if (item.kind === 'number') {
    let frame = renderCounting(picture, item);
    el.querySelector('[data-act="recount"]')?.addEventListener('click', () => {
      silence();
      frame.remove();
      frame = renderCounting(picture, item);
    });
  } else if (item.emoji) {
    const pic = document.createElement('button');
    pic.className = 'card-emoji';
    pic.textContent = item.emoji;
    pic.setAttribute('aria-label', item.word || item.label?.en || '');
    const ids = item.kind === 'letter' ? [item.clips.word].filter(Boolean) : clipsToSay(item);
    pic.addEventListener('click', () => speak(pic, ids));
    picture.append(pic);
  } else {
    picture.remove();
  }

  el.querySelector('[data-act="home"]').addEventListener('click', () => go('#/'));
  el.querySelector('[data-act="back"]').addEventListener('click', () => go(pickerHashFor(catalog, item)));
  el.querySelector('[data-act="trace"]')?.addEventListener('click', () => go(`#/trace/${item.id}`));
  root.append(el);
  return () => silence();
}

/**
 * Ten-frame counting: N identical objects in rows of five. Each object counts once, on its first
 * tap, and stays filled in. The spoken number is the running count (in the chosen language(s)),
 * whichever object he taps. A tap while a number is being said stops it and says the new one.
 * The last object says what was counted instead: "five turtles" / 五隻烏龜 (settings.js
 * countDoneClips). Zero is an empty frame. "Count again" and every new visit start afresh.
 */
const countOf = (item) => Number(item.glyph.split(':')[1]);

function renderCounting(box, item) {
  const n = countOf(item);
  const frame = document.createElement('div');
  frame.className = 'ten-frame';
  let counted = 0;
  for (let i = 0; i < 10; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (i < n) {
      const obj = document.createElement('button');
      obj.className = 'count-obj';
      obj.textContent = item.count_emoji;
      obj.setAttribute('aria-label', 'count');
      obj.addEventListener('click', () => {
        if (obj.classList.contains('counted')) return;   // each object counts once
        obj.classList.add('counted');
        counted += 1;
        playSequence(counted === n ? countDoneClips(item, n, hasClip) : countClips(counted));
      });
      cell.append(obj);
    }
    frame.append(cell);
  }
  box.append(frame);
  return frame;
}
