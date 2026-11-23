import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPalmGuard, QUIET_MS } from './pen.js';

// Elements, just enough for takeClick's matching.
const el = (name, parent = null) => ({ name, parent, contains(o) { for (let x = o; x; x = x.parent) if (x === this) return true; return false; } });
const button = el('button');
const icon = el('icon', button);
const canvas = el('canvas');

function setup() {
  let t = 0;
  const g = createPalmGuard(() => t);
  const ev = (type, pointerType, pointerId, target = canvas) => g.observe({ type, pointerType, pointerId, target });
  return { g, ev, at: (ms) => { t = ms; } };
}

test('without the Pencil, touches are fingers and their taps work', () => {
  const { g, ev } = setup();
  ev('pointerdown', 'touch', 1, button);
  assert.equal(g.isPalm(1), false);
  ev('pointerup', 'touch', 1, button);
  assert.equal(g.takeClick(button), false);
});

test("a touch while the Pencil is down is a hand, and its tap on that element does nothing", () => {
  const { g, ev, at } = setup();
  ev('pointerdown', 'pen', 9);
  at(100);
  ev('pointerdown', 'touch', 1, icon);
  assert.equal(g.isPalm(1), true);
  at(200);
  ev('pointerup', 'touch', 1, icon);
  assert.equal(g.isPalm(1), true, 'still known as a hand for the lift handlers');
  assert.equal(g.takeClick(button), true, "the hand's click is dropped (target contains the lift element)");
  assert.equal(g.takeClick(button), false, 'only that one click');
});

test('a hand already resting becomes a palm when the Pencil lands, and listeners hear it', () => {
  const { g, ev } = setup();
  const heard = [];
  const off = g.onPalms((ids) => heard.push(...ids));
  ev('pointerdown', 'touch', 1);
  assert.equal(g.isPalm(1), false);
  ev('pointerdown', 'pen', 9);
  assert.equal(g.isPalm(1), true);
  assert.deepEqual(heard, [1]);
  ev('pointerup', 'pen', 9);
  ev('pointerdown', 'pen', 9);
  assert.deepEqual(heard, [1], 'told once per touch');
  off();
});

test('fingers work again QUIET_MS after the Pencil was last seen', () => {
  const { g, ev, at } = setup();
  ev('pointerdown', 'pen', 9);
  at(50);
  ev('pointerup', 'pen', 9);
  at(50 + QUIET_MS - 1);
  ev('pointerdown', 'touch', 1);
  assert.equal(g.isPalm(1), true);
  ev('pointerup', 'touch', 1);
  at(50 + QUIET_MS + 700);
  ev('pointerdown', 'touch', 1, button);
  assert.equal(g.isPalm(1), false, 'a reused id is judged afresh');
  ev('pointerup', 'touch', 1, button);
  assert.equal(g.takeClick(button), false);
});

test('a hovering Pencil counts as in use', () => {
  const { g, ev, at } = setup();
  ev('pointermove', 'pen', 9);
  at(300);
  ev('pointerdown', 'touch', 1);
  assert.equal(g.isPalm(1), true);
});

test("the Pencil's own tap works while a hand lifts elsewhere", () => {
  const { g, ev, at } = setup();
  ev('pointerdown', 'pen', 9);
  ev('pointerdown', 'touch', 1, canvas);
  at(100);
  ev('pointerup', 'touch', 1, canvas);
  ev('pointerup', 'pen', 9, button);
  assert.equal(g.takeClick(button), false);
});

test('a cancelled hand makes no click, so none is dropped', () => {
  const { g, ev } = setup();
  ev('pointerdown', 'touch', 1, button);
  ev('pointerdown', 'pen', 9, button);
  ev('pointercancel', 'touch', 1, button);
  ev('pointerup', 'pen', 9, button);
  assert.equal(g.takeClick(button), false, "the Pencil's tap on the same button works");
});

test('a Pencil whose lift was lost stops blocking fingers', () => {
  const { g, ev, at } = setup();
  ev('pointerdown', 'pen', 9);
  at(31000);
  ev('pointerdown', 'touch', 1);
  assert.equal(g.isPalm(1), false);
  ev('pointerup', 'touch', 1);
  g.reset();
  ev('pointerdown', 'touch', 2);
  assert.equal(g.isPalm(2), false);
});

test('mouse input is never a palm', () => {
  const { g, ev } = setup();
  ev('pointerdown', 'pen', 9);
  ev('pointerdown', 'mouse', 1);
  assert.equal(g.isPalm(1), false);
});

test('a hand that lands while a still Pencil looks stale is caught when the Pencil moves', () => {
  const { g, ev, at } = setup();
  const heard = [];
  g.onPalms((ids) => heard.push(...ids));
  ev('pointerdown', 'pen', 9);
  at(31000);
  ev('pointerdown', 'touch', 1);
  assert.equal(g.isPalm(1), false);
  ev('pointermove', 'pen', 9);
  assert.equal(g.isPalm(1), true);
  assert.deepEqual(heard, [1]);
});

test('a hovering Pencil does not take over a finger already drawing', () => {
  const { g, ev } = setup();
  ev('pointerdown', 'touch', 1);
  ev('pointermove', 'pen', 9);
  assert.equal(g.isPalm(1), false);
});

test("a lifted hand's id is forgotten: reused by the Pencil, or after a while", () => {
  const { g, ev, at } = setup();
  ev('pointerdown', 'pen', 9);
  ev('pointerdown', 'touch', 1);
  ev('pointerup', 'touch', 1);
  ev('pointerup', 'pen', 9);
  assert.equal(g.isPalm(1), true);
  ev('pointerdown', 'pen', 1);
  assert.equal(g.isPalm(1), false, 'the Pencil reusing the id is not a hand');
  ev('pointerdown', 'touch', 2);
  ev('pointerup', 'touch', 2);
  ev('pointerup', 'pen', 1);
  assert.equal(g.isPalm(2), true);
  at(7000);
  ev('pointerdown', 'mouse', 5);
  assert.equal(g.isPalm(2), false);
});

test("a Pencil tap on a button inside where a hand lifted is not dropped", () => {
  const { g, ev, at } = setup();
  const grid = el('grid');
  const tile = el('tile', grid);
  ev('pointerdown', 'pen', 9);
  ev('pointerdown', 'touch', 1, grid);
  at(100);
  ev('pointerup', 'touch', 1, grid);        // the hand slid, so it made no click
  ev('pointerup', 'pen', 9, tile);
  assert.equal(g.takeClick(tile), false);
});
