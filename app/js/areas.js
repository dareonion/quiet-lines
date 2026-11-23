import { icons } from './icons.js';

/** The five things on Home. A picker shows 6 items a page (calm rule 5). */
export const PAGE = 6;

export const AREAS = [
  { id: 'draw', icon: icons.draw, label: 'Draw' },
  { id: 'shapes', kind: 'shape', icon: icons.shapes, label: 'Shapes' },
  { id: 'numbers', kind: 'number', text: '123', label: 'Numbers' },
  { id: 'letters', kind: 'letter', text: 'ABC', label: 'Letters' },
  { id: 'hanzi', kind: 'hanzi', text: '中文', label: 'Chinese' },
];

export function areaOf(kind) {
  return AREAS.find((a) => a.kind === kind);
}

export function itemsOf(catalog, kind) {
  return catalog.items.filter((i) => i.kind === kind);
}

/** The picker page an item sits on, for the "back to the list" button. */
export function pickerHashFor(catalog, item) {
  const list = itemsOf(catalog, item.kind);
  const page = Math.max(0, Math.floor(list.findIndex((i) => i.id === item.id) / PAGE));
  return `#/area/${areaOf(item.kind).id}/${page}`;
}

/** Where tapping an item goes: its card (tap to hear it, then trace from there). */
export function itemHash(item) {
  return `#/card/${item.id}`;
}
