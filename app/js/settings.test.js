// What the last counted object says (settings.js countDoneClips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDoneClips } from './settings.js';

const five = { kind: 'number', clips: { en: 'num.5.en', zh: 'num.5.zh' }, count_clips: { en: 'count.5.en', zh: 'count.5.zh' } };
const has = (ids) => (id) => ids.includes(id);
const all = has(['count.5.en', 'count.5.zh']);

test('the phrase, in each chosen language', () => {
  assert.deepEqual(countDoneClips(five, 5, all, { lang: 'en' }), ['count.5.en']);
  assert.deepEqual(countDoneClips(five, 5, all, { lang: 'zh' }), ['count.5.zh']);
  assert.deepEqual(countDoneClips(five, 5, all, { lang: 'both' }), ['count.5.en', 'count.5.zh']);
});

test('without every chosen phrase (a self-hosted copy part-recorded), the number again, as before', () => {
  const enOnly = has(['count.5.en']);
  assert.deepEqual(countDoneClips(five, 5, enOnly, { lang: 'both' }), ['num.5.en', 'num.5.zh', 'num.5.en', 'num.5.zh']);
  assert.deepEqual(countDoneClips(five, 5, enOnly, { lang: 'en' }), ['count.5.en']);
  assert.deepEqual(countDoneClips(five, 5, enOnly, { lang: 'zh' }), ['num.5.zh', 'num.5.zh']);
  assert.deepEqual(countDoneClips(five, 5, has([]), { lang: 'en' }), ['num.5.en', 'num.5.en']);
});
