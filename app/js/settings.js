// Parent settings, kept on the device. localStorage can throw or be empty (private mode,
// cleared site data), so every access is guarded and defaults always work.

const KEY = 'toddler.settings.v1';
const DEFAULTS = { lang: 'both', ease: 'easy', voices: {} };

export function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* keep defaults */ }
  return next;
}

/** The languages numbers and shapes are said in, in order. ABC is English, 中文 is Mandarin. */
export function langsFor(kind, settings = getSettings()) {
  if (kind === 'letter') return ['en'];
  if (kind === 'hanzi') return ['zh'];
  if (settings.lang === 'en') return ['en'];
  if (settings.lang === 'zh') return ['zh'];
  return ['en', 'zh'];
}

/** Which of an item's clips to say for its name, in order. */
export function clipsToSay(item, settings = getSettings()) {
  const c = item.clips || {};
  return langsFor(item.kind, settings).map((l) => c[l]).filter(Boolean);
}

/** The clips for saying a running count, in the chosen language(s) (plan, "Counting"). */
export function countClips(n, settings = getSettings()) {
  return langsFor('number', settings).map((l) => `num.${n}.${l}`);
}
