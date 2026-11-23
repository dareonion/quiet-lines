import { playSequence, selectedVoice, silence } from '../audio.js';
import { getSettings, saveSettings } from '../settings.js';

/** Parent area (behind the 3-second hold): offline status and settings. */
export function renderParent(root, { go, release, swStatus, onSwStatus, checkForUpdate }) {
  const el = document.createElement('section');
  el.className = 'screen parent';
  el.innerHTML = `
    <div class="parent-body">
      <h1>For parents</h1>
      <p class="status" data-role="status"></p>
      <button class="pbtn" data-act="update">Check for an update</button>
      <h2>Say numbers and shapes in</h2>
      <div class="seg" data-setting="lang">
        <button data-value="en">English</button><button data-value="zh">中文</button><button data-value="both">Both</button>
      </div>
      <h2>Tracing</h2>
      <div class="seg" data-setting="ease">
        <button data-value="easy">Easy (either direction, wide)</button><button data-value="normal">Normal</button>
      </div>
      <p class="note">Keep your child in the app with Guided Access (Settings → Accessibility → Guided
        Access), which can also end the session after a set time.${release?.recorder
          ? ' Recordings are made at <b>/record</b> on this app\'s address, from a phone or a computer.' : ''}</p>
      <button class="pbtn done" data-act="done">Done</button>
    </div>`;

  for (const [lang, title] of [['en', 'English voice'], ['zh', '中文 voice']]) {
    const packs = Object.entries(release?.voices?.packs ?? {}).filter(([, pack]) => pack.lang === lang)
      .sort(([, a], [, b]) => (b.default - a.default) || a.label.localeCompare(b.label));   // default first
    if (packs.length < 2) continue;
    const heading = document.createElement('h2');
    heading.textContent = title;
    const row = document.createElement('div');
    row.className = 'seg';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', title);
    for (const [id, pack] of packs) {
      const button = document.createElement('button');
      button.textContent = pack.label;
      button.setAttribute('aria-pressed', String(id === selectedVoice(lang)));
      button.addEventListener('click', () => {
        saveSettings({ voices: { ...getSettings().voices, [lang]: id } });
        for (const b of row.children) b.setAttribute('aria-pressed', String(b === button));
        const one = `${id}/num.1.${lang}`;
        const sample = release.clips[one] ? one : Object.keys(release.clips).find((key) => key.startsWith(id + '/'));
        if (sample) playSequence([sample]);
      });
      row.append(button);
    }
    el.querySelector('.note').before(heading, row);
  }

  if (release?.voices?.disclosure) {
    const disclosure = document.createElement('p');
    disclosure.className = 'note';
    disclosure.textContent = release.voices.disclosure;
    el.querySelector('.done').before(disclosure);
  }

  const statusEl = el.querySelector('[data-role="status"]');
  const showStatus = (s) => {
    const id = s.release ? s.release.slice(0, 6) : 'unknown';
    let text;
    if (!s.supported) text = 'This browser cannot keep the app offline.';
    else if (!s.standalone) text = `Release ${id}. This is a Safari tab, which keeps its own copy. Use Share → Add to Home Screen, then open the new icon once while online and check for ✓ there.`;
    else if (s.waiting) text = `Release ${id}. An update has downloaded and switches over the next time the app is on its home screen.`;
    else if (s.installing) text = `Release ${id}. Downloading for offline use… stay online with the app open.`;
    else if (s.switching) text = `Release ${id}. Saved for offline use; it finishes switching the next time the app is on its home screen.`;
    else if (s.controlled) text = `Release ${id}. Ready offline ✓ (no connection needed).`;
    else text = `Release ${id}. Not yet saved for offline use: stay online, then reopen the app.`;
    if (s.lastCheck === 'failed') text = `The update check failed. ${text}`;
    if (s.lastCheck === 'checking') text = `Checking for an update… ${text}`;
    statusEl.textContent = text;
  };
  showStatus(swStatus());
  const off = onSwStatus(showStatus);

  const settings = getSettings();
  for (const seg of el.querySelectorAll('[data-setting]')) {
    const key = seg.dataset.setting;
    const paint = (v) => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    paint(settings[key]);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      saveSettings({ [key]: b.dataset.value });
      paint(b.dataset.value);
    });
  }
  el.querySelector('[data-act="update"]').addEventListener('click', () => {
    Promise.resolve(checkForUpdate()).finally(() => showStatus(swStatus()));
  });
  el.querySelector('[data-act="done"]').addEventListener('click', () => go('#/'));
  root.append(el);
  return () => { off(); silence(); };
}
