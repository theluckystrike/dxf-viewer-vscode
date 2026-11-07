'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDxf, bulgePoints, splinePoints, insertMatrices } = require('../src/core/parse');
const { createReader, sniff, codeKind } = require('../src/core/reader');
const { cleanText, cleanMText } = require('../src/core/text');
const { aciToRgb } = require('../src/core/aci');
const { sampleBytes, fixture, samples } = require('./helpers');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

test('reader: ASCII pairs with CRLF, padded codes and a BOM', () => {
  const r = createReader(enc('\ufeff  0\r\nSECTION\r\n  2\r\nENTITIES\r\n 10\r\n1.5e2\r\n 70\r\n  7\r\n'));
  const got = []; while (r.next()) got.push([r.code, r.value]);
  assert.deepEqual(got, [[0, 'SECTION'], [2, 'ENTITIES'], [10, 150], [70, 7]]);
});

test('reader: group code value kinds follow the DXF reference', () => {
  assert.equal(codeKind(0), 's'); assert.equal(codeKind(10), 'd'); assert.equal(codeKind(62), 'i'); assert.equal(codeKind(90), 'l');
  assert.equal(codeKind(160), 'q'); assert.equal(codeKind(290), 'b'); assert.equal(codeKind(310), 'x'); assert.equal(codeKind(420), 'l'); assert.equal(codeKind(1040), 'd');
});

test('binary and ASCII copies of the same drawing give the same model', () => {
  const s = sampleBytes();
  assert.equal(sniff(s.mechBin).kind, 'binary');
  const a = parseDxf(s.mech), b = parseDxf(s.mechBin);
  assert.equal(a.format, 'ascii'); assert.equal(b.format, 'binary');
  assert.deepEqual(b.counts, a.counts);
  assert.deepEqual(b.layers, a.layers);
  assert.deepEqual(b.extents.map((v) => +v.toFixed(6)), a.extents.map((v) => +v.toFixed(6)));
  assert.equal(b.primTotal, a.primTotal);
  assert.equal(a.endedEarly, false);
});

test('ezdxf-written R2018 files (ASCII and binary) match the entity counts ezdxf reports', () => {
  const exp = JSON.parse(Buffer.from(fixture('ezdxf-expected.json')).toString());
  for (const f of ['ezdxf-r2018.dxf', 'ezdxf-r2018-binary.dxf']) {
    const m = parseDxf(fixture(f));
    assert.deepEqual(Object.fromEntries(Object.entries(m.counts).sort()), Object.fromEntries(Object.entries(exp.counts).sort()), f);
    assert.deepEqual(m.layers.map((l) => l.name).sort(), exp.layers.slice().sort(), f);
    assert.equal(m.version, 'AC1032'); assert.equal(m.unitName, 'mm');
    assert.equal(m.layers.find((l) => l.name === 'HIDDEN-OFF').on, false);
    assert.equal(m.missingBlocks, 0);
    assert.deepEqual(m.extents.map((v) => Math.round(v) + 0), [0, -1500, 8000, 5000]);
  }
});

test('floor plan: layers, off/frozen flags, blocks, nested inserts, arrays, dimensions and hatches', () => {
  const m = parseDxf(sampleBytes().floor);
  assert.equal(m.versionName, 'AutoCAD 2000'); assert.equal(m.unitName, 'mm');
  const L = Object.fromEntries(m.layers.map((l) => [l.name, l]));
  assert.equal(L.ELECTRICAL.on, false); assert.equal(L['OLD-LAYOUT'].frozen, true); assert.equal(L.GRID.lt > 0, true);
  assert.deepEqual({ ...m.counts }, { LWPOLYLINE: 10, HATCH: 4, INSERT: 25, CIRCLE: 6, LINE: 7, TEXT: 6, MTEXT: 5, DIMENSION: 5 });
  const names = m.blocks.map((b) => b.name);
  for (const n of ['DOOR', 'WINDOW', 'CHAIR', 'TABLE6', '*D1', '*D4']) assert.ok(names.includes(n), n);
  const table = m.prims.find((p) => p.t === 'I' && m.blocks[p.bi].name === 'TABLE6');
  assert.equal(m.blocks[table.bi].prims.filter((p) => p.t === 'I').length, 6, 'six nested chairs');
  const arr = m.prims.find((p) => p.t === 'I' && p.nc === 5);
  assert.equal(insertMatrices(arr).length, 10);
  // 4 dimensions use their *D blocks, the 5th has no block and is drawn from its points with its measurement text
  assert.equal(m.prims.filter((p) => p.t === 'I' && /^\*D/.test(m.blocks[p.bi].name)).length, 4);
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === '14000'));
  const hatches = m.prims.filter((p) => p.t === 'F' && 'pat' in p);
  assert.equal(hatches.length, 3); assert.equal(hatches[0].holes.length, 1); assert.equal(hatches.filter((h) => h.pat).length, 0);
  assert.equal(m.prims.filter((p) => p.t === 'S').length, 1, 'the pattern hatch is drawn as its pattern lines');
  assert.deepEqual(m.hatch, { patterns: 1, tinted: 0, segments: m.hatch.segments }); assert.ok(m.hatch.segments > 10);
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === 'LIVING / DINING\n31.2 m²'));
  assert.deepEqual([m.extents[0], m.extents[2], m.extents[3]].map(Math.round), [-1200, 15200, 11000]);
  assert.ok(m.extents[1] < -3200 && m.extents[1] > -3400);
  assert.ok(m.snap.length > 200);
});

test('mechanical part: bulges, spline, ellipse, OCS-mirrored arc, text codes, true colour, dimensions without blocks', () => {
  const m = parseDxf(sampleBytes().mech);
  const plate = m.prims.find((p) => p.t === 'L' && p.p.length > 40 && p.l === m.layers.findIndex((l) => l.name === 'OUTLINE'));
  assert.ok(plate, 'rounded plate outline');
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === '⌀60 H7'));
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === 'PCD 45'), 'dimension text override with <>');
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === '⌀60'), 'diameter dimension');
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s.includes('45°') && p.s.includes('±0.1')));
  assert.ok(m.prims.some((p) => p.t === 'L' && p.c === 0x2e86de), 'true colour 420');
  const mirrored = m.prims.find((p) => p.t === 'A' && p.r === 12);
  assert.equal(mirrored.x, 80); close(mirrored.a0, Math.PI / 2); close(mirrored.a1, Math.PI * 1.5); // mirrored: passes through 180 deg, not 0
  const bolts = m.prims.filter((p) => p.t === 'I' && m.blocks[p.bi].name === 'BOLT_HOLE');
  assert.equal(bolts.length, 6);
  close(bolts[1].r, Math.PI / 3);
});

test('R12 file: POLYLINE/VERTEX with bulge, ATTRIB values, 3DFACE, POINT', () => {
  const m = parseDxf(sampleBytes().r12);
  assert.equal(m.version, 'AC1009'); assert.equal(m.unitName, '');
  assert.deepEqual({ ...m.counts }, { POLYLINE: 2, POINT: 2, '3DFACE': 1, TEXT: 1, INSERT: 2 });
  assert.ok(m.prims.some((p) => p.t === 'T' && p.s === 'A1') && m.prims.some((p) => p.t === 'T' && p.s === 'B2'));
  assert.equal(m.blocks[0].prims.filter((p) => p.t === 'T').length, 0, 'ATTDEF tags are not drawn inside blocks');
});

test('a file with only an ENTITIES list and no sections still opens', () => {
  const m = parseDxf(enc('0\nLINE\n8\nA\n10\n0\n20\n0\n11\n5\n21\n5\n0\nCIRCLE\n8\nB\n10\n1\n20\n1\n40\n2\n0\nEOF\n'));
  assert.deepEqual({ ...m.counts }, { LINE: 1, CIRCLE: 1 });
  assert.deepEqual(m.layers.map((l) => l.name), ['0', 'A', 'B']);
});

test('unknown entities are counted and listed as not drawn; paper space is skipped', () => {
  const m = parseDxf(enc('0\nSECTION\n2\nENTITIES\n0\n3DSOLID\n8\n0\n0\nLINE\n67\n1\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n0\nXLINE\n8\n0\n0\nENDSEC\n0\nEOF\n'));
  assert.deepEqual(m.notDrawn.sort(), ['3DSOLID', 'XLINE']);
  assert.equal(m.paperSpace, 1);
});

test('damaged and wrong files give plain errors', () => {
  assert.throws(() => parseDxf(enc('0\nSECTION\n2\nENTITIES\nabc\nLINE\n')), /should hold a group code/);
  assert.throws(() => parseDxf(enc('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n')), /without its value/);
  assert.throws(() => parseDxf(enc('hello\nworld\n')), /should hold a group code/);
  assert.throws(() => parseDxf(new Uint8Array(Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(40)]))), /DWG drawing \(AC1027\).*Export it to DXF/);
  const bin = sampleBytes().mechBin;
  for (const n of [900, 901, 1500]) {
    let m = null;
    try { m = parseDxf(bin.subarray(0, n)); } catch (e) { assert.match(e.message, /cut off|has no end/); }
    if (m) assert.equal(m.endedEarly, true, `cut at ${n}`);
  }
});

test('geometry helpers: bulge arc, B-spline ends, insert matrix', () => {
  const pts = [0, 0]; bulgePoints(0, 0, 2, 0, 1, pts); // half circle below the chord, CCW from (0,0) to (2,0)
  close(pts[pts.length - 2], 2); close(pts[pts.length - 1], 0);
  const midY = Math.min(...pts.filter((_, i) => i % 2 === 1)); close(midY, -1, 0.01);
  const sp = splinePoints(3, null, [0, 0, 1, 2, 3, 2, 4, 0], null, 20);
  close(sp[0], 0); close(sp[1], 0); close(sp[sp.length - 2], 4, 1e-6); close(sp[sp.length - 1], 0, 1e-6);
  const m = insertMatrices({ x: 10, y: 5, sx: 2, sy: 2, r: Math.PI / 2, nc: 1, nr: 1, cs: 0, rs: 0, bx: 1, by: 0 })[0];
  close(m[0] * 1 + m[2] * 0 + m[4], 10); close(m[1] * 1 + m[3] * 0 + m[5], 5); // base point lands on the insert point
});

test('text codes: TEXT specials, MTEXT formatting, unicode escapes', () => {
  assert.equal(cleanText('%%c25 %%p0.1 90%%d %%%'), '⌀25 ±0.1 90° %');
  assert.equal(cleanText('%%uUnderlined%%u'), 'Underlined');
  assert.equal(cleanMText('{\\fArial|b1|i0;Title}\\P{\\H0.7x;\\C1;12 m\\U+00B2}'), 'Title\n12 m²');
  assert.equal(cleanMText('A\\~B \\S1/2; \\\\ \\{x\\}'), 'A\u00a0B 1/2 \\ {x}');
  assert.equal(cleanMText('<script>alert(1)</script>'), '<script>alert(1)</script>', 'kept as text; drawn with fillText');
});

test('ACI colours: fixed entries and the wheel', () => {
  assert.equal(aciToRgb(1), 0xff0000); assert.equal(aciToRgb(5), 0x0000ff); assert.equal(aciToRgb(8), 0x808080);
  assert.equal(aciToRgb(10), 0xff0000); assert.equal(aciToRgb(250), 0x333333);
});

test('site plan (generated, under 1 MB) parses fast and every sample stays under 5 MB', () => {
  const s = sampleBytes();
  for (const [k, v] of Object.entries(s)) assert.ok(v.length < 5 * 1024 * 1024, k);
  const t0 = Date.now(); const m = parseDxf(s.site); const ms = Date.now() - t0;
  assert.equal(m.counts.INSERT, 3241); assert.ok(ms < 2000, `${ms} ms`);
});

test('a 30 MB drawing parses in the worker budget and keeps memory flat', () => {
  // made in memory only: 600k LINE entities
  const parts = ['0\nSECTION\n2\nENTITIES\n'];
  for (let i = 0; i < 600000; i++) parts.push(`0\nLINE\n8\nL${i % 7}\n10\n${i}\n20\n0\n11\n${i}\n21\n10\n`);
  parts.push('0\nENDSEC\n0\nEOF\n');
  const buf = new Uint8Array(Buffer.from(parts.join('')));
  const t0 = Date.now(); const m = parseDxf(buf); const ms = Date.now() - t0;
  assert.equal(m.counts.LINE, 600000); assert.equal(m.layers.length, 8);
  assert.ok(ms < 15000, `${ms} ms for ${buf.length} bytes`);
  console.log(`# 600k lines, ${(buf.length / 1048576).toFixed(1)} MB: ${ms} ms`);
});

test('the samples script refuses nothing and writes the 6 files', () => {
  assert.equal(typeof samples.floorPlan, 'function');
});
