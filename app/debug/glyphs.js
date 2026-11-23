import { parsePath, polylineLength, samplePath } from '../js/trace/path.js';

const colors = [
  '#596f83', '#a16a51', '#6c8057', '#93728f', '#548381', '#ac843f',
  '#805e66', '#777e93', '#907850', '#56705f', '#ad7971',
];
const status = document.querySelector('#status');

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.status + ' ' + url.split('/').pop());
  return response.json();
}

function svg(parent, tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent.append(node);
  return node;
}

// path.js ignores unrecognised tokens. Surface those in the review as well.
function checkSyntax(d) {
  if (typeof d !== 'string' || !/^\s*M/i.test(d) ||
      d.replace(/[MLHVCQZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[\s,]/gi, '')) {
    throw new Error('unsupported path syntax');
  }
}

function startLabel(group, positions, [x, y], index, color) {
  // Two strokes can start at exactly the same spot (A and the heart).
  let label;
  for (const r of [5, 10, 16, 23]) {
    for (const [dx, dy] of [[-1,-1], [1,-1], [-1,1], [1,1], [0,-1], [0,1]]) {
      const px = x + r*dx, py = y + r*dy;
      if (px < 0 || px > 100 || py < 0 || py > 100) continue;
      if (positions.every(([lx, ly]) => Math.hypot(px-lx, py-ly) >= 9)) {
        label = [px, py];
        break;
      }
    }
    if (label) break;
  }
  const [px, py] = label ?? [x, y];
  positions.push([px, py]);
  svg(group, 'line', {x1:x, y1:y, x2:px, y2:py, stroke:color, 'stroke-width':0.7});
  svg(group, 'circle', {cx:x, cy:y, r:1.4, fill:color});
  svg(group, 'text', {x:px, y:py, 'text-anchor':'middle', dy:'.35em'}).textContent = index + 1;
}

function markedStroke(layers, d, index, positions, report) {
  checkSyntax(d);
  const points = samplePath(d, 0.5);
  const length = polylineLength(points);
  if (length < 12) report('Stroke ' + (index + 1) + ' is ' + length.toFixed(1) + ' units');
  const color = colors[index % colors.length];
  svg(layers.guide, 'path', {d, 'stroke-width':6});
  svg(layers.ink, 'path', {d, stroke:color, 'stroke-width':2});
  if (points.length > 1) {
    const tip = Math.max(1, Math.round(0.7 * (points.length - 1)));
    const [x, y] = points[tip], [ax, ay] = points[Math.max(0, tip - 3)];
    const angle = Math.atan2(y-ay, x-ax) * 180 / Math.PI;
    svg(layers.arrows, 'path', {d:'M0 0 L-6 -2.7 L-6 2.7 Z', fill:color,
      transform:'translate(' + x + ' ' + y + ') rotate(' + angle + ')'});
  }
  if (points.length) startLabel(layers.labels, positions, points[0], index, color);
}

async function tile(grid, id, items, latin, clips) {
  const fig = document.createElement('figure');
  grid.append(fig);
  const art = svg(fig, 'svg', {viewBox:'-5 -5 110 110', 'aria-label':id, role:'img'});
  const caption = document.createElement('figcaption');
  fig.append(caption);
  const code = document.createElement('code');
  code.textContent = id;
  caption.append(code);
  for (const item of items) {
    const label = item.label ? [item.label.en, item.label.zh].join(' · ') :
      item.word || clips[item.clips.en]?.text || item.text;
    const line = document.createElement('div');
    line.textContent = [item.emoji ?? item.count_emoji, label, item.word_note].filter(Boolean).join(' ');
    caption.append(line);
  }
  function report(message) {
    fig.classList.add('invalid');
    const note = document.createElement('small');
    note.textContent = message;
    caption.append(note);
  }

  try {
    const [family, name] = id.split(':');
    const outlines = svg(art, 'g', {fill:'#e1dbcf'});
    let strokes;
    if (family === 'latin') {
      strokes = latin.glyphs[name].strokes;
    } else {
      const filename = name.codePointAt(0).toString(16) + '.json';
      const data = await json('../content/glyphs/hanzi/' + filename);
      if (data.char !== name || data.box !== 1024 || data.y_flip !== 900) throw new Error('Invalid glyph metadata');
      if (data.strokes.length !== data.medians.length || items.some(item => item.strokes !== data.strokes.length)) {
        report('Stroke count differs from medians or catalog');
      }
      const scale = 100 / data.box;
      outlines.setAttribute('transform', 'scale(' + scale + ') translate(0 900) scale(1 -1)');
      data.strokes.forEach((d, i) => {
        try {
          checkSyntax(d);
          parsePath(d); // An outline can have several subpaths.
          svg(outlines, 'path', {d});
        } catch (err) { report('Outline ' + (i + 1) + ': ' + err.message); }
      });
      strokes = data.medians.map(points => points.map(([x, y], i) =>
        (i ? 'L' : 'M') + x * scale + ' ' + (900-y) * scale).join(' '));
    }
    const layers = {
      guide:svg(art, 'g', {fill:'none', stroke:'#ece7dc', 'stroke-linecap':'round', 'stroke-linejoin':'round'}),
      ink:svg(art, 'g', {fill:'none', 'stroke-linecap':'round', 'stroke-linejoin':'round'}),
      arrows:svg(art, 'g', {}), labels:svg(art, 'g', {}),
    };
    const positions = [];
    if (!strokes.length) report('No strokes');
    strokes.forEach((d, i) => {
      try { markedStroke(layers, d, i, positions, report); }
      catch (err) { report('Stroke ' + (i + 1) + ': ' + err.message); }
    });
  } catch (err) { report(err.message); }
}

async function render() {
  const [catalog, latin] = await Promise.all([json('../content/catalog.json'), json('../content/glyphs/latin.json')]);
  const groups = new Map();
  const records = new Map();
  for (const item of catalog.items) {
    if (!records.has(item.glyph)) records.set(item.glyph, {kind:item.kind, items:[]});
    records.get(item.glyph).items.push(item);
  }
  for (const name of Object.keys(latin.glyphs)) {
    const id = 'latin:' + name;
    if (!records.has(id)) records.set(id, {kind:'other', items:[]});
  }

  const titles = {shape:'Shapes', number:'Numbers', letter:'Letters', hanzi:'Traditional Chinese', other:'Other glyphs'};
  await Promise.all(Array.from(records, ([id, {kind, items}]) => {
    if (!groups.has(kind)) {
      const heading = document.createElement('h2');
      heading.textContent = titles[kind];
      const grid = document.createElement('div');
      grid.className = 'grid';
      document.querySelector('main').append(heading, grid);
      groups.set(kind, grid);
    }
    return tile(groups.get(kind), id, items, latin, catalog.clips);
  }));
  const flagged = document.querySelectorAll('figure.invalid').length;
  status.textContent = records.size + ' glyphs · ' + flagged + ' flagged';
}

render().catch(err => { status.textContent = 'Could not load the contact sheet: ' + err.message; });
