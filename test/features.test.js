'use strict';
// 0.2.0 features: paper space sheets with viewports, hatch pattern lines, Find text, live reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseDxf, hatchSegments } = require('../src/core/parse');
const { vpMatrix, findTexts, hitBox } = require('../src/core/view');
const { fixture } = require('./helpers');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const dxf = (pairs) => enc(pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n0\nEOF\n');
const exp = JSON.parse(Buffer.from(fixture('ezdxf-layouts-expected.json')).toString());
const model = () => parseDxf(fixture('ezdxf-layouts.dxf'));

test('sheets: ezdxf layouts come in tab order with their own entities and viewports', () => {
  const m = model();
  assert.deepEqual(m.layouts.map((L) => L.name), exp.layouts.map((L) => L.name));
  m.layouts.forEach((L, i) => {
    const e = exp.layouts[i];
    assert.deepEqual(L.prims.map((p) => ({ L: 'LWPOLYLINE', T: 'TEXT' }[p.t])).sort(), e.entities, L.name);
    const vps = e.viewports.filter((v) => v.id !== 1); // id 1 is the sheet itself
    assert.equal(L.vps.length, vps.length, L.name);
    L.vps.forEach((v, j) => {
      close(v.x, vps[j].center[0]); close(v.y, vps[j].center[1]); close(v.w, vps[j].w); close(v.h, vps[j].h);
      close(v.vx, vps[j].view_center[0]); close(v.vy, vps[j].view_center[1]); close(v.vh, vps[j].view_height);
      assert.deepEqual(v.frozen.map((li) => m.layers[li].name), vps[j].frozen);
    });
    assert.ok(L.box && L.box[2] > L.box[0], 'sheet has extents');
  });
  // model space keeps only model entities
  assert.equal(m.counts.VIEWPORT, undefined);
  assert.ok(m.paperSpace > 0);
});

test('sheets: the viewport transform puts the view centre on the viewport centre at the right scale', () => {
  const v = model().layouts[0].vps[0];
  const M = vpMatrix(v), T = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const c = T(5000, 2500); close(c[0], 210); close(c[1], 160);
  const top = T(5000, 2500 + 11000 / 2); close(top[1], 160 + 110); // view height fills the viewport height
  const tw = vpMatrix({ x: 0, y: 0, w: 10, h: 10, vx: 0, vy: 0, vh: 10, tw: Math.PI / 2 });
  close(tw[0] * 1 + tw[4], 0); close(tw[1] * 1 + tw[5], 1); // twist turns +X into +Y
});

test('sheets: R12-style paper space without LAYOUT objects still gets one sheet; model is unchanged', () => {
  const m = parseDxf(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 10], [21, 0],
    [0, 'TEXT'], [8, 'TITLE'], [67, 1], [10, 5], [20, 5], [40, 2], [1, 'TITLE BLOCK'], [0, 'ENDSEC']]));
  assert.equal(m.layouts.length, 1); assert.equal(m.layouts[0].name, 'Sheet 1');
  assert.deepEqual(m.layouts[0].texts.map((t) => t.s), ['TITLE BLOCK']);
  assert.deepEqual({ ...m.counts }, { LINE: 1 });
});

test('sheets: broken viewports and layouts pointing nowhere are skipped, never an error', () => {
  const m = parseDxf(dxf([[0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 100], [41, 80], [68, 1], [69, 2], [12, 0], [22, 0], [45, 0],
    [0, 'VIEWPORT'], [8, '0'], [67, 1], [10, 50], [20, 50], [40, 100], [41, 80], [68, 1], [69, 3], [12, 0], [22, 0], [45, 40], [331, 'FFFF'],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'OBJECTS'], [0, 'LAYOUT'], [5, 'A1'], [100, 'AcDbLayout'], [1, 'Ghost'], [71, 2], [330, 'DEAD'], [0, 'ENDSEC']]));
  const vps = m.layouts.flatMap((L) => L.vps);
  assert.equal(vps.length, 1, 'the zero-height view is dropped');
  assert.deepEqual(vps[0].frozen, [], 'unknown layer handle is ignored');
  assert.equal(m.counts.LINE, 1);
});

test('hatch patterns: ANSI31 from ezdxf is drawn as 45 degree lines, clipped to the boundary and the hole', () => {
  const m = model();
  assert.deepEqual(m.hatch.patterns, 1); assert.equal(m.hatch.tinted, 0);
  const S = m.prims.find((p) => p.t === 'S');
  assert.ok(S, 'pattern segments exist'); assert.ok(!m.prims.some((p) => p.t === 'F' && p.pat), 'no tint fallback');
  const L = exp.hatch.lines[0];
  const off = Math.hypot(L[2][0], L[2][1]);
  const dists = new Set();
  for (let i = 0; i < S.p.length; i += 4) {
    const [x1, y1, x2, y2] = S.p.slice(i, i + 4);
    close(Math.atan2(y2 - y1, x2 - x1), Math.PI / 4, 1e-9);
    for (const [x, y] of [[x1, y1], [x2, y2]]) assert.ok(x >= -1e-6 && x <= 10000 + 1e-6 && y >= -1e-6 && y <= 6000 + 1e-6, `inside ${x},${y}`);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    assert.ok(!(mx > 4000 && mx < 6000 && my > 2000 && my < 4000), 'nothing inside the hole');
    dists.add(Math.round((y1 - x1) / Math.SQRT2 / off * 1000) / 1000); // perpendicular distance in line spacings
  }
  for (const d of dists) close(d, Math.round(d), 1e-3);
});

test('hatch patterns: dashes, dots and the per-line shift follow the pattern definition', () => {
  const sq = [[0, 0, 100, 0, 100, 100, 0, 100]];
  const segs = hatchSegments(sq, [{ a: 0, bx: 0, by: 0, ox: 5, oy: 20, d: [10, -5, 0, -5] }], 1e5);
  const lens = []; for (let i = 0; i < segs.length; i += 4) lens.push(Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]));
  assert.ok(lens.every((l) => l <= 10 + 1e-9));
  assert.ok(lens.some((l) => l === 0), 'dots are zero-length segments (round caps draw them)');
  const first = segs.slice(0, 4); close(first[1], 0); close(first[0], 0); // line 0 starts with a dash at its origin
  const row1 = []; for (let i = 0; i < segs.length; i += 4) if (Math.abs(segs[i + 1] - 20) < 1e-9 && segs[i + 2] - segs[i] > 0) row1.push(segs[i]);
  assert.ok(row1.includes(5) && Math.min(...row1) === 5, 'line 1 starts 5 along, from its own origin');
});

test('hatch patterns: a pattern too dense to draw falls back to the tint with a note, never a blank', () => {
  const pairs = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'HATCH'], [8, 'H'], [2, 'DENSE'], [70, 0], [71, 0], [91, 1], [92, 2], [72, 0], [73, 1], [93, 4],
    [10, 0], [20, 0], [10, 1000], [20, 0], [10, 1000], [20, 1000], [10, 0], [20, 1000], [97, 0], [75, 0], [76, 1], [52, 0], [41, 1], [77, 0], [78, 1],
    [53, 0], [43, 0], [44, 0], [45, 0], [46, 0.01], [79, 0], [98, 0], [0, 'ENDSEC']];
  const m = parseDxf(dxf(pairs));
  assert.equal(m.hatch.tinted, 1); assert.equal(m.hatch.patterns, 0);
  const F = m.prims.find((p) => p.t === 'F'); assert.ok(F && F.pat === 1);
});

test('find: TEXT, MTEXT and block attributes are found at their world position; hidden layers are left out', () => {
  const m = model();
  assert.deepEqual(m.texts.map((t) => t.s).sort(), ['PUMP-101', 'T-42', 'Valve V-7 check weekly']);
  const tag = findTexts(m.texts, 't-4', null);
  assert.equal(tag.length, 1); close(tag[0].x, 8500); close(tag[0].y, 5000);
  assert.equal(findTexts(m.texts, 'valve', null).length, 1);
  assert.equal(findTexts(m.texts, '   ', null).length, 0);
  const notes = m.layers.findIndex((L) => L.name === 'NOTES');
  assert.deepEqual(findTexts(m.texts, 'pump', new Set([notes])), []);
  assert.deepEqual(findTexts(m.layouts[1].texts, 'detail', null).map((t) => t.s), ['DETAIL D-1']);
  const b = hitBox({ s: 'AB', x: 10, y: 20, h: 1, r: 0, ha: 0, va: 0 });
  assert.ok(b[0][0] < 10 && b[2][0] > 10 + 1.2 && b[0][1] < 20 && b[2][1] > 21);
});

test('find and sheets: big drawings keep the text index bounded', () => {
  const pairs = [[0, 'SECTION'], [2, 'ENTITIES']];
  for (let i = 0; i < 60000; i++) pairs.push([0, 'TEXT'], [8, '0'], [10, i], [20, 0], [40, 1], [1, 'N' + i]);
  pairs.push([0, 'ENDSEC']);
  const m = parseDxf(dxf(pairs));
  assert.equal(m.texts.length, 50000);
});

test('live reload: setting in the manifest, watcher wired in the provider and disposed with the panel', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const s = pkg.contributes.configuration.properties['dxfViewer.liveReload'];
  assert.equal(s.type, 'boolean'); assert.equal(s.default, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.match(src, /createFileSystemWatcher\(new vscode\.RelativePattern/);
  assert.match(src, /watcher\.dispose\(\)/);
});
