'use strict';
// Turns DXF group codes into a compact drawing model the webview can draw.
// Primitive kinds: L polyline, A arc/circle, F filled polygon, T text, I block insert, P point.
// Colour spec c: >= 0 RGB, -1 BYLAYER, -2 BYBLOCK, -7 foreground (ACI 7). Linetype lt: -1 BYLAYER, -2 BYBLOCK, 0 solid, n index.
const { createReader, sniff, DxfError } = require('./reader');
const { aciToRgb } = require('./aci');
const { cleanText, cleanMText } = require('./text');

const LIMITS = { prims: 1500000, snap: 100000, depth: 16, splineSeg: 400 };
const UNITS = ['', 'in', 'ft', 'mi', 'mm', 'cm', 'm', 'km', 'µin', 'mil', 'yd', 'Å', 'nm', 'µm', 'dm', 'dam', 'hm', 'Gm', 'AU', 'ly', 'pc', 'US ft', 'US in', 'US yd', 'US mi'];
const VERSIONS = { AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018' };
const DRAWN = new Set(['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'POINT', 'TEXT', 'MTEXT', 'INSERT', 'ELLIPSE', 'SPLINE', 'SOLID', 'TRACE', '3DFACE', 'HATCH', 'DIMENSION', 'LEADER', 'ATTRIB', 'RAY', 'XLINE', 'ACAD_TABLE']);
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

function colorSpec(aci, rgb) {
  if (rgb !== undefined && rgb !== null) return rgb & 0xffffff;
  if (aci === undefined || aci === null || aci === 256) return -1;
  if (aci === 0) return -2;
  const a = Math.abs(aci);
  if (a === 7 || a === 255) return -7;
  return aciToRgb(a);
}

/** Point on an arc of a polyline segment with a bulge, appended to out (start excluded, end included). */
function bulgePoints(x1, y1, x2, y2, b, out) {
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  if (!b || d < 1e-12) { out.push(x2, y2); return; }
  const theta = 4 * Math.atan(b);
  const h = d * (1 - b * b) / (4 * b);
  const cx = (x1 + x2) / 2 - dy / d * h, cy = (y1 + y2) / 2 + dx / d * h;
  const r = Math.hypot(x1 - cx, y1 - cy), a1 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.min(64, Math.ceil(Math.abs(theta) / (Math.PI / 36))));
  for (let k = 1; k < n; k++) { const a = a1 + theta * k / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  out.push(x2, y2);
}

/** De Boor evaluation of a (rational) B-spline, sampled into a flat point list. */
function splinePoints(deg, knots, ctrl, weights, samples) {
  const n = ctrl.length / 2;
  if (n < 2) return ctrl.slice();
  if (!knots || knots.length !== n + deg + 1) {
    knots = []; for (let i = 0; i <= n + deg; i++) knots.push(i <= deg ? 0 : i >= n ? n - deg : i - deg);
  }
  const w = weights && weights.length === n ? weights : null;
  const t0 = knots[deg], t1 = knots[n];
  const out = [];
  const d = new Array((deg + 1) * 3);
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 - 1e-12 * (t1 - t0 || 1) : t0 + (t1 - t0) * s / samples;
    let k = deg; while (k < n - 1 && knots[k + 1] <= t) k++;
    for (let j = 0; j <= deg; j++) { const i = k - deg + j, ww = w ? w[i] : 1; d[j * 3] = ctrl[i * 2] * ww; d[j * 3 + 1] = ctrl[i * 2 + 1] * ww; d[j * 3 + 2] = ww; }
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        for (let c = 0; c < 3; c++) d[j * 3 + c] = (1 - a) * d[(j - 1) * 3 + c] + a * d[j * 3 + c];
      }
    }
    const ww = d[deg * 3 + 2] || 1;
    out.push(d[deg * 3] / ww, d[deg * 3 + 1] / ww);
  }
  return out;
}

function ellipsePoints(cx, cy, mx, my, ratio, p0, p1) {
  let span = p1 - p0; while (span <= 0) span += TAU;
  const n = Math.max(8, Math.ceil(96 * span / TAU));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = p0 + span * k / n, c = Math.cos(t), s = Math.sin(t);
    out.push(cx + mx * c - my * ratio * s, cy + my * c + mx * ratio * s);
  }
  return out;
}

function fmtNum(v) {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.?0+$/, '');
}

class Parser {
  constructor(bytes, opts = {}) {
    this.r = createReader(bytes);
    this.opts = opts;
    this.header = {};
    this.layers = []; this.layerIdx = new Map();
    this.ltypes = [{ name: 'CONTINUOUS', pattern: [] }]; this.ltIdx = new Map([['CONTINUOUS', 0]]);
    this.blocks = []; this.blockIdx = new Map();
    this.prims = [];
    this.counts = Object.create(null); this.blockCounts = Object.create(null);
    this.paperSpace = 0; this.invisible = 0; this.primTotal = 0; this.truncated = false;
    this.warnings = [];
    this.sections = [];
    this.layer('0');
  }

  layer(name) {
    const key = String(name || '0').toUpperCase();
    let i = this.layerIdx.get(key);
    if (i === undefined) {
      i = this.layers.length;
      this.layers.push({ name: String(name || '0'), color: 0xffffff, aci: 7, on: true, frozen: false, lt: 0, count: 0, fromTable: false });
      this.layerIdx.set(key, i);
    }
    return i;
  }

  ltype(name) {
    if (name === undefined || name === null) return -1;
    const key = String(name).toUpperCase();
    if (key === 'BYLAYER') return -1;
    if (key === 'BYBLOCK') return -2;
    const i = this.ltIdx.get(key);
    return i === undefined ? 0 : i;
  }

  /** Reads one entity: its type and its group codes until the next code 0. */
  readEntity() {
    const r = this.r;
    if (this.pending) { const p = this.pending; this.pending = null; return p; }
    if (!r.next()) return null;
    if (r.code !== 0) throw new DxfError(`Expected an entity start (group code 0) but found group code ${r.code}.`, r.offset);
    const type = String(r.value).trim().toUpperCase();
    const tags = [];
    while (r.next()) {
      if (r.code === 0) { r.back(); break; }
      tags.push(r.code, r.value);
    }
    return { type, tags };
  }

  parse() {
    const r = this.r;
    while (r.next()) {
      if (r.code === 0 && r.value === 'EOF') { this.sawEof = true; break; }
      if (r.code === 999) continue;
      if (r.code !== 0 || r.value !== 'SECTION') {
        if (this.sections.length === 0 && r.code === 0) { r.back(); this.sections.push('ENTITIES'); this.entitySection(this.prims, this.counts, true, true); continue; }
        continue;
      }
      if (!r.next() || r.code !== 2) throw new DxfError('A SECTION has no name.', r.offset);
      const name = String(r.value).trim().toUpperCase();
      this.sections.push(name);
      if (name === 'HEADER') this.headerSection();
      else if (name === 'TABLES') this.tablesSection();
      else if (name === 'BLOCKS') this.blocksSection();
      else if (name === 'ENTITIES') this.entitySection(this.prims, this.counts, true);
      else this.skipSection();
    }
    if (!this.sections.length) throw new DxfError('No DXF sections were found. This does not look like a DXF file.', 0);
    return this.finish();
  }

  skipSection() {
    const r = this.r;
    while (r.next()) if (r.code === 0 && r.value === 'ENDSEC') return;
  }

  headerSection() {
    const r = this.r;
    let key = null;
    while (r.next()) {
      if (r.code === 0) { if (r.value === 'ENDSEC') return; continue; }
      if (r.code === 9) { key = String(r.value); continue; }
      if (!key) continue;
      const h = this.header;
      if (r.code === 10) h[key] = [r.value, 0];
      else if (r.code === 20 && Array.isArray(h[key])) h[key][1] = r.value;
      else if (r.code !== 30) h[key] = r.value;
    }
  }

  tablesSection() {
    let table = null;
    for (;;) {
      const e = this.readEntity();
      if (!e) return;
      if (e.type === 'ENDSEC') return;
      if (e.type === 'TABLE') { table = String(tagVal(e.tags, 2, '')).toUpperCase(); continue; }
      if (e.type === 'ENDTAB') { table = null; continue; }
      if (table === 'LAYER' && e.type === 'LAYER') {
        const name = String(tagVal(e.tags, 2, '0'));
        const i = this.layer(name);
        const L = this.layers[i];
        const aci = tagVal(e.tags, 62, 7), rgb = tagVal(e.tags, 420, null), flags = tagVal(e.tags, 70, 0);
        L.aci = aci; L.color = rgb !== null ? rgb & 0xffffff : (Math.abs(aci) === 7 ? -7 : aciToRgb(aci));
        L.on = aci >= 0; L.frozen = (flags & 1) === 1; L.lt = this.ltype(tagVal(e.tags, 6, 'CONTINUOUS'));
        if (L.lt < 0) L.lt = 0;
        L.fromTable = true;
      } else if (table === 'LTYPE' && e.type === 'LTYPE') {
        const name = String(tagVal(e.tags, 2, ''));
        const pattern = [];
        for (let k = 0; k < e.tags.length; k += 2) if (e.tags[k] === 49) pattern.push(Number(e.tags[k + 1]) || 0);
        const key = name.toUpperCase();
        if (key && !this.ltIdx.has(key) && key !== 'BYLAYER' && key !== 'BYBLOCK') { this.ltIdx.set(key, this.ltypes.length); this.ltypes.push({ name, pattern }); }
      }
    }
  }

  blocksSection() {
    for (;;) {
      const e = this.readEntity();
      if (!e || e.type === 'ENDSEC') return;
      if (e.type !== 'BLOCK') continue;
      const name = String(tagVal(e.tags, 2, ''));
      const blk = { name, base: [tagVal(e.tags, 10, 0), tagVal(e.tags, 20, 0)], prims: [], flags: tagVal(e.tags, 70, 0) };
      const key = name.toUpperCase();
      const isLayout = /^\*(MODEL|PAPER)_SPACE/.test(key);
      this.entitySection(blk.prims, this.blockCounts, false, false, 'ENDBLK');
      if (isLayout) continue; // layout blocks hold paper space or duplicates of ENTITIES
      if (!this.blockIdx.has(key)) { this.blockIdx.set(key, this.blocks.length); this.blocks.push(blk); }
    }
  }

  /** Reads entities until ENDSEC (or `end`), converting each to primitives in `out`. */
  entitySection(out, counts, topLevel, noSection, end = 'ENDSEC') {
    for (;;) {
      const e = this.readEntity();
      if (!e) return;
      if (e.type === end || e.type === 'ENDSEC' || e.type === 'EOF') { if (e.type === 'EOF') this.sawEof = true; return; }
      let extra = null;
      if (e.type === 'POLYLINE') extra = this.readSequence('VERTEX');
      else if (e.type === 'INSERT' && tagVal(e.tags, 66, 0) === 1) extra = this.readSequence('ATTRIB');
      if (e.type === 'SEQEND' || e.type === 'VERTEX') continue;
      if (e.type === 'ATTDEF' && !topLevel) continue; // shown by the ATTRIBs of each insert instead
      if (tagVal(e.tags, 67, 0) === 1 && topLevel) { this.paperSpace++; continue; }
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (tagVal(e.tags, 60, 0) === 1) { this.invisible++; continue; }
      const before = out.length;
      this.entity(e, extra, out);
      if (topLevel && out.length > before) {
        const li = out[before].l;
        if (li !== undefined) this.layers[li].count++;
      }
    }
  }

  readSequence(child) {
    const list = [];
    for (;;) {
      const e = this.readEntity();
      if (!e) return list;
      if (e.type === child) { list.push(e); continue; }
      if (e.type === 'SEQEND') return list;
      // A missing SEQEND: hand the entity back so the caller reads it next.
      this.pending = e;
      return list;
    }
  }

  push(out, p) {
    if (this.primTotal >= LIMITS.prims) { this.truncated = true; return; }
    this.primTotal++; out.push(p);
  }

  common(tags) {
    return {
      l: this.layer(tagVal(tags, 8, '0')),
      c: colorSpec(tagVal(tags, 62, undefined), tagVal(tags, 420, null)),
      lt: this.ltype(tagVal(tags, 6, undefined)),
      lts: tagVal(tags, 48, 1),
    };
  }

  entity(e, extra, out) {
    const t = e.tags, g = (c, d) => tagVal(t, c, d);
    const base = this.common(t);
    const ocsFlip = g(230, 1) < 0; // extrusion (0,0,-1): mirrored about the Y axis
    const fx = ocsFlip ? -1 : 1;
    const P = (o) => Object.assign(o, base);
    switch (e.type) {
      case 'LINE': this.push(out, P({ t: 'L', p: [g(10, 0), g(20, 0), g(11, 0), g(21, 0)] })); break;
      case 'POINT': this.push(out, P({ t: 'P', x: g(10, 0), y: g(20, 0) })); break;
      case 'CIRCLE': this.push(out, P({ t: 'A', x: fx * g(10, 0), y: g(20, 0), r: Math.abs(g(40, 0)), a0: 0, a1: TAU })); break;
      case 'ARC': {
        let a0 = g(50, 0) * D2R, a1 = g(51, 360) * D2R;
        if (ocsFlip) { const s = Math.PI - a1; a1 = Math.PI - a0; a0 = s; }
        a0 = ((a0 % TAU) + TAU) % TAU; while (a1 <= a0) a1 += TAU; while (a1 - a0 > TAU) a1 -= TAU;
        this.push(out, P({ t: 'A', x: fx * g(10, 0), y: g(20, 0), r: Math.abs(g(40, 0)), a0, a1 }));
        break;
      }
      case 'ELLIPSE': {
        const cx = g(10, 0), cy = g(20, 0), mx = g(11, 1), my = g(21, 0), ratio = g(40, 1);
        let p0 = g(41, 0), p1 = g(42, TAU);
        let pts = ellipsePoints(cx, cy, mx, my, ratio, p0, p1);
        if (g(230, 1) < 0) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];
        this.push(out, P({ t: 'L', p: pts }));
        break;
      }
      case 'LWPOLYLINE': {
        const verts = [];
        let cur = null;
        for (let k = 0; k < t.length; k += 2) {
          const c = t[k], v = t[k + 1];
          if (c === 10) { cur = [v, 0, 0]; verts.push(cur); } else if (c === 20 && cur) cur[1] = v; else if (c === 42 && cur) cur[2] = v;
        }
        const closed = (g(70, 0) & 1) === 1;
        const pts = polyPoints(verts, closed);
        if (ocsFlip) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];
        if (pts.length >= 2) this.push(out, P({ t: 'L', p: pts }));
        break;
      }
      case 'POLYLINE': {
        const flags = g(70, 0), verts = extra || [];
        if (flags & 64) { // polyface mesh: vertex records then face records
          const vp = [], faces = [];
          for (const v of verts) {
            const vf = tagVal(v.tags, 70, 0);
            if ((vf & 128) && !(vf & 64)) faces.push([71, 72, 73, 74].map((c) => Math.abs(tagVal(v.tags, c, 0))));
            else vp.push([tagVal(v.tags, 10, 0), tagVal(v.tags, 20, 0)]);
          }
          for (const f of faces) {
            const pts = []; for (const i of f) if (i > 0 && vp[i - 1]) pts.push(vp[i - 1][0], vp[i - 1][1]);
            if (pts.length >= 4) { pts.push(pts[0], pts[1]); this.push(out, P({ t: 'L', p: pts })); }
          }
          break;
        }
        if (flags & 16) { // polygon mesh M x N
          const m = g(71, 0), n = g(72, 0), vp = verts.map((v) => [tagVal(v.tags, 10, 0), tagVal(v.tags, 20, 0)]);
          if (m * n === vp.length && m > 0 && n > 0) {
            for (let i = 0; i < m; i++) { const pts = []; for (let j = 0; j < n; j++) pts.push(...vp[i * n + j]); this.push(out, P({ t: 'L', p: pts })); }
            for (let j = 0; j < n; j++) { const pts = []; for (let i = 0; i < m; i++) pts.push(...vp[i * n + j]); this.push(out, P({ t: 'L', p: pts })); }
          }
          break;
        }
        const vv = verts.filter((v) => !(tagVal(v.tags, 70, 0) & 16)).map((v) => [tagVal(v.tags, 10, 0), tagVal(v.tags, 20, 0), tagVal(v.tags, 42, 0)]);
        const pts = polyPoints(vv, (flags & 1) === 1);
        if (ocsFlip) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];
        if (pts.length >= 2) this.push(out, P({ t: 'L', p: pts }));
        break;
      }
      case 'SPLINE': {
        const deg = g(71, 3), ctrl = [], fit = [], knots = [], weights = [];
        for (let k = 0; k < t.length; k += 2) {
          const c = t[k], v = t[k + 1];
          if (c === 10) ctrl.push(v, 0); else if (c === 20) ctrl[ctrl.length - 1] = v;
          else if (c === 11) fit.push(v, 0); else if (c === 21) fit[fit.length - 1] = v;
          else if (c === 40) knots.push(v); else if (c === 41) weights.push(v);
        }
        let pts;
        if (ctrl.length >= 4) pts = splinePoints(Math.max(1, deg), knots, ctrl, weights, Math.min(LIMITS.splineSeg, Math.max(16, ctrl.length * 8)));
        else pts = fit;
        if ((g(70, 0) & 1) && pts.length >= 4) pts.push(pts[0], pts[1]);
        if (pts.length >= 4) this.push(out, P({ t: 'L', p: pts }));
        break;
      }
      case 'SOLID': case 'TRACE': case '3DFACE': {
        const q = [g(10, 0), g(20, 0), g(11, 0), g(21, 0), g(12, g(11, 0)), g(22, g(21, 0)), g(13, g(12, g(11, 0))), g(23, g(22, g(21, 0)))];
        if (e.type === '3DFACE') this.push(out, P({ t: 'L', p: [q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[0], q[1]] }));
        else this.push(out, P({ t: 'F', p: [q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]].map((v, i) => (i % 2 === 0 ? fx * v : v)) }));
        break;
      }
      case 'TEXT': case 'ATTRIB': case 'ATTDEF': {
        if (e.type !== 'TEXT' && (g(70, 0) & 1)) break; // invisible attribute
        const s = cleanText(String(e.type === 'ATTDEF' ? g(2, '') : g(1, '')));
        if (!s) break;
        const h = g(40, 1), ha = g(72, 0), va = g(e.type === 'TEXT' ? 73 : 74, 0);
        const useAlign = (ha !== 0 || va !== 0) && ha !== 3 && ha !== 5;
        let x = useAlign ? g(11, g(10, 0)) : g(10, 0), y = useAlign ? g(21, g(20, 0)) : g(20, 0);
        let rot = g(50, 0) * D2R;
        if (ha === 3 || ha === 5) { const x2 = g(11, x), y2 = g(21, y); if (x2 !== x || y2 !== y) rot = Math.atan2(y2 - y, x2 - x); }
        if (ocsFlip) { x = -x; rot = Math.PI - rot; }
        this.push(out, P({ t: 'T', x, y, h, r: rot, s, ha: ha === 4 ? 1 : (ha > 2 ? 0 : ha), va: ha === 4 ? 2 : va, wf: g(41, 1) || 1 }));
        break;
      }
      case 'MTEXT': {
        let raw = '';
        for (let k = 0; k < t.length; k += 2) if (t[k] === 3) raw += t[k + 1];
        raw += String(g(1, ''));
        const s = cleanMText(raw);
        if (!s) break;
        const att = g(71, 1);
        let rot = g(50, 0) * D2R;
        const dx = g(11, null), dy = g(21, null);
        if (dx !== null && (dx !== 0 || dy)) rot = Math.atan2(dy || 0, dx);
        this.push(out, P({ t: 'T', x: g(10, 0), y: g(20, 0), h: g(40, 1), r: rot, s, ha: (att - 1) % 3, va: att <= 3 ? 3 : att <= 6 ? 2 : 1, wf: 1, w: g(41, 0), ls: g(44, 1) || 1, m: 1 }));
        break;
      }
      case 'INSERT': {
        const ins = P({ t: 'I', b: String(g(2, '')), x: fx * g(10, 0), y: g(20, 0), sx: fx * g(41, 1), sy: g(42, 1), r: g(50, 0) * D2R * fx, nc: Math.max(1, g(70, 1)), nr: Math.max(1, g(71, 1)), cs: g(44, 0), rs: g(45, 0) });
        if (!ins.sx) ins.sx = 1; if (!ins.sy) ins.sy = 1;
        this.push(out, ins);
        for (const a of extra || []) this.entity(a, null, out);
        break;
      }
      case 'DIMENSION': this.dimension(t, base, out); break;
      case 'LEADER': {
        const pts = [];
        for (let k = 0; k < t.length; k += 2) { if (t[k] === 10) pts.push(t[k + 1], 0); else if (t[k] === 20) pts[pts.length - 1] = t[k + 1]; }
        if (pts.length >= 4) {
          this.push(out, P({ t: 'L', p: pts }));
          if (g(71, 1)) this.push(out, P({ t: 'F', p: arrowHead(pts[2], pts[3], pts[0], pts[1], (this.header.$DIMASZ || 2.5) * (this.header.$DIMSCALE || 1)) }));
        }
        break;
      }
      case 'HATCH': this.hatch(t, base, out); break;
      case 'ACAD_TABLE': {
        const b = g(2, null);
        if (b) this.push(out, P({ t: 'I', b: String(b), x: 0, y: 0, sx: 1, sy: 1, r: 0, nc: 1, nr: 1, cs: 0, rs: 0, anon: 1 }));
        break;
      }
      default: break; // counted, not drawn (XLINE, RAY, IMAGE, 3DSOLID, VIEWPORT, ...)
    }
  }

  dimension(t, base, out) {
    const g = (c, d) => tagVal(t, c, d);
    const b = g(2, null);
    const type = g(70, 0) & 7;
    const meas = g(42, null);
    const p10 = [g(10, 0), g(20, 0)], p11 = [g(11, null), g(21, null)], p13 = [g(13, 0), g(23, 0)], p14 = [g(14, 0), g(24, 0)], p15 = [g(15, 0), g(25, 0)];
    const fallback = [];
    const H = this.header;
    const th = (H.$DIMTXT || 2.5) * (H.$DIMSCALE || 1);
    const P = (o) => Object.assign(o, base);
    let value = meas, mid = p11[0] !== null ? p11 : null;
    if (type === 0 || type === 1) {
      const ang = type === 0 ? g(50, 0) * D2R : Math.atan2(p14[1] - p13[1], p14[0] - p13[0]);
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const proj = (p) => { const k = (p[0] - p10[0]) * ux + (p[1] - p10[1]) * uy; return [p10[0] + ux * k, p10[1] + uy * k]; };
      const q1 = proj(p13), q2 = proj(p14);
      fallback.push(P({ t: 'L', p: [p13[0], p13[1], q1[0], q1[1]] }), P({ t: 'L', p: [p14[0], p14[1], q2[0], q2[1]] }), P({ t: 'L', p: [q1[0], q1[1], q2[0], q2[1]] }));
      const asz = (H.$DIMASZ || 2.5) * (H.$DIMSCALE || 1);
      fallback.push(P({ t: 'F', p: arrowHead(q2[0], q2[1], q1[0], q1[1], asz) }), P({ t: 'F', p: arrowHead(q1[0], q1[1], q2[0], q2[1], asz) }));
      if (value === null) value = Math.abs((p14[0] - p13[0]) * ux + (p14[1] - p13[1]) * uy);
      if (!mid) mid = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    } else if (type === 3 || type === 4) {
      fallback.push(P({ t: 'L', p: [p15[0], p15[1], p10[0], p10[1]] }));
      if (value === null) value = Math.hypot(p15[0] - p10[0], p15[1] - p10[1]);
      if (!mid) mid = p10;
    }
    let text = String(g(1, '') ?? '');
    const num = value === null ? '' : (type === 3 ? '%%c' : type === 4 ? 'R' : '') + fmtNum(value);
    if (!text || text === '<>') text = num; else text = text.replace('<>', num);
    if (text !== ' ' && mid) fallback.push(P({ t: 'T', x: mid[0], y: mid[1], h: th, r: g(53, null) !== null ? g(53, 0) * D2R : (type === 0 ? g(50, 0) * D2R : 0), s: cleanMText(text), ha: 1, va: 1, wf: 1 }));
    // The drawing's own dimension block wins when it exists; it is placed in world coordinates.
    this.push(out, P({ t: 'I', b: b ? String(b) : '', x: g(12, 0), y: g(22, 0), sx: 1, sy: 1, r: 0, nc: 1, nr: 1, cs: 0, rs: 0, anon: 1, fb: fallback }));
  }

  hatch(t, base, out) {
    const g = (c, d) => tagVal(t, c, d);
    const solid = g(70, 0) === 1;
    const loops = [];
    let k = 0;
    // skip to the boundary path count (91)
    while (k < t.length && t[k] !== 91) k += 2;
    const nLoops = k < t.length ? t[k + 1] : 0; k += 2;
    const next = () => { const c = t[k], v = t[k + 1]; k += 2; return [c, v]; };
    const want = (code) => { while (k < t.length && t[k] !== code) k += 2; if (k >= t.length) return null; return next()[1]; };
    for (let li = 0; li < nLoops && k < t.length; li++) {
      const flags = want(92);
      if (flags === null) break;
      const pts = [];
      if (flags & 2) {
        const hasBulge = want(72), closed = want(73), n = want(93);
        const verts = [];
        for (let i = 0; i < n && k < t.length; i++) {
          const x = want(10), y = want(20); let b = 0;
          if (hasBulge && t[k] === 42) b = next()[1];
          verts.push([x, y, b]);
        }
        pts.push(...polyPoints(verts, true || closed));
      } else {
        const n = want(93);
        for (let i = 0; i < n && k < t.length; i++) {
          const et = want(72);
          if (et === 1) { const x1 = want(10), y1 = want(20), x2 = want(11), y2 = want(21); if (!pts.length) pts.push(x1, y1); pts.push(x2, y2); }
          else if (et === 2) {
            const cx = want(10), cy = want(20), r = want(40); let a0 = want(50) * D2R, a1 = want(51) * D2R; const ccw = want(73);
            // clockwise edges store mirrored angles (360 - angle)
            let span = a1 - a0; while (span <= 0) span += TAU;
            const m = Math.max(4, Math.ceil(span / (Math.PI / 36)));
            const sg = ccw ? 1 : -1;
            for (let j = 0; j <= m; j++) { const a = a0 + span * j / m; pts.push(cx + r * Math.cos(a), cy + sg * r * Math.sin(a)); }
          } else if (et === 3) {
            const cx = want(10), cy = want(20), mx = want(11), my = want(21), ratio = want(40); const a0 = want(50) * D2R, a1 = want(51) * D2R; const ccw = want(73);
            const seg = ellipsePoints(cx, cy, mx, my, ratio, a0, a1);
            if (!ccw) { // mirror across the major axis
              const L = Math.hypot(mx, my) || 1, ux = mx / L, uy = my / L;
              for (let j = 0; j < seg.length; j += 2) { const dx = seg[j] - cx, dy = seg[j + 1] - cy, d = dx * ux + dy * uy; seg[j] = cx + 2 * d * ux - dx; seg[j + 1] = cy + 2 * d * uy - dy; }
            }
            pts.push(...seg);
          } else if (et === 4) {
            const deg = want(94); want(73); want(74); const nk = want(95), nc = want(96);
            const knots = [], ctrl = [];
            for (let j = 0; j < nk; j++) knots.push(want(40));
            for (let j = 0; j < nc; j++) ctrl.push(want(10), want(20));
            pts.push(...splinePoints(deg || 3, knots, ctrl, null, Math.min(LIMITS.splineSeg, nc * 8)));
          } else break;
        }
      }
      // source boundary objects
      if (t[k] === 97) { const ns = t[k + 1]; k += 2 + ns * 2; }
      if (pts.length >= 6) loops.push(pts);
    }
    if (!loops.length) return;
    const P = (o) => Object.assign(o, base);
    this.push(out, P({ t: 'F', p: loops[0], holes: loops.slice(1), pat: solid ? 0 : 1 }));
  }

  finish() {
    const blocks = this.blocks;
    const resolve = (list) => {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.t !== 'I') continue;
        const bi = this.blockIdx.get(p.b.toUpperCase());
        const blk = bi === undefined ? null : blocks[bi];
        if (blk && blk.prims.length) {
          p.bi = bi;
          if (p.anon) { p.bx = 0; p.by = 0; } else { p.bx = blk.base[0]; p.by = blk.base[1]; }
          delete p.fb;
        } else if (p.fb) {
          list.splice(i, 1, ...p.fb); i += p.fb.length - 1;
        } else { p.bi = -1; this.missingBlocks = (this.missingBlocks || 0) + 1; }
        if (p.t === 'I') delete p.anon;
      }
    };
    resolve(this.prims);
    for (const b of blocks) resolve(b.prims);
    const ex = this.extents();
    const H = this.header;
    const ver = String(H.$ACADVER || '');
    const insUnits = Number(H.$INSUNITS || 0);
    const usedLayers = this.layers;
    return {
      format: this.r.kind,
      version: ver, versionName: VERSIONS[ver] || (ver ? ver : 'R12 or older (no version in header)'),
      units: insUnits, unitName: UNITS[insUnits] || '',
      layers: usedLayers.map((L) => ({ name: L.name, color: L.color, aci: L.aci, on: L.on, frozen: L.frozen, lt: L.lt, count: L.count })),
      ltypes: this.ltypes.map((t) => ({ name: t.name, pattern: t.pattern })),
      ltscale: Number(H.$LTSCALE) || 1,
      blocks: blocks.map((b) => ({ name: b.name, prims: b.prims })),
      prims: this.prims,
      counts: this.counts, blockCounts: this.blockCounts,
      drawn: Object.keys(this.counts).concat(Object.keys(this.blockCounts)).filter((k) => DRAWN.has(k)),
      notDrawn: [...new Set(Object.keys(this.counts).concat(Object.keys(this.blockCounts)).filter((k) => !DRAWN.has(k) || k === 'RAY' || k === 'XLINE'))],
      paperSpace: this.paperSpace, invisible: this.invisible, missingBlocks: this.missingBlocks || 0,
      truncated: this.truncated, primTotal: this.primTotal, endedEarly: !this.sawEof,
      extents: ex.box, snap: ex.snap,
      sections: this.sections,
    };
  }

  /** World extents and snap points, walking inserts through their transforms. */
  extents() {
    const blocks = this.blocks;
    const memo = new Map();
    const snap = [];
    const boxOf = (prims, depth, seen) => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      const add = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
      for (const p of prims) {
        if (p.t === 'L' || p.t === 'F') for (let i = 0; i < p.p.length; i += 2) add(p.p[i], p.p[i + 1]);
        else if (p.t === 'A') arcBox(p, add);
        else if (p.t === 'P') add(p.x, p.y);
        else if (p.t === 'T') textBox(p, add);
        else if (p.t === 'I' && p.bi >= 0 && depth < LIMITS.depth && !seen.has(p.bi)) {
          const bb = blockBox(p.bi, depth + 1, seen);
          if (bb[0] > bb[2]) continue;
          for (const m of insertMatrices(p)) for (const [cx, cy] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]) add(m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]);
        }
      }
      return b;
    };
    const blockBox = (bi, depth, seen) => {
      if (memo.has(bi)) return memo.get(bi);
      seen.add(bi);
      const bb = boxOf(blocks[bi].prims, depth, seen);
      seen.delete(bi);
      memo.set(bi, bb);
      return bb;
    };
    const box = boxOf(this.prims, 0, new Set());
    // snap points: vertices, arc ends and centres, insert points, through block transforms
    const walk = (prims, m, depth) => {
      for (const p of prims) {
        if (snap.length >= LIMITS.snap * 2) return;
        const T = (x, y) => { snap.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]); };
        if (p.t === 'L') { const n = p.p.length; if (n <= 64) for (let i = 0; i < n; i += 2) T(p.p[i], p.p[i + 1]); else { T(p.p[0], p.p[1]); T(p.p[n - 2], p.p[n - 1]); } }
        else if (p.t === 'A') { T(p.x, p.y); if (p.a1 - p.a0 >= TAU - 1e-9) { T(p.x + p.r, p.y); T(p.x - p.r, p.y); T(p.x, p.y + p.r); T(p.x, p.y - p.r); } else { T(p.x + p.r * Math.cos(p.a0), p.y + p.r * Math.sin(p.a0)); T(p.x + p.r * Math.cos(p.a1), p.y + p.r * Math.sin(p.a1)); } }
        else if (p.t === 'P') T(p.x, p.y);
        else if (p.t === 'I' && p.bi >= 0 && depth < 6) { for (const im of insertMatrices(p)) walk(blocks[p.bi].prims, mul(m, im), depth + 1); }
      }
    };
    walk(this.prims, [1, 0, 0, 1, 0, 0], 0);
    return { box: box[0] <= box[2] ? box : null, snap };
  }
}

function arrowHead(x, y, fromX, fromY, size) {
  const a = Math.atan2(y - fromY, x - fromX), w = size / 6;
  const bx = x - Math.cos(a) * size, by = y - Math.sin(a) * size;
  return [x, y, bx - Math.sin(a) * w, by + Math.cos(a) * w, bx + Math.sin(a) * w, by - Math.cos(a) * w];
}

function polyPoints(verts, closed) {
  const out = [];
  if (!verts.length) return out;
  out.push(verts[0][0], verts[0][1]);
  const n = verts.length;
  for (let i = 0; i < n - 1; i++) bulgePoints(verts[i][0], verts[i][1], verts[i + 1][0], verts[i + 1][1], verts[i][2] || 0, out);
  if (closed && n > 1) bulgePoints(verts[n - 1][0], verts[n - 1][1], verts[0][0], verts[0][1], verts[n - 1][2] || 0, out);
  return out;
}

function arcBox(p, add) {
  if (p.a1 - p.a0 >= TAU - 1e-9) { add(p.x - p.r, p.y - p.r); add(p.x + p.r, p.y + p.r); return; }
  let a0 = p.a0, a1 = p.a1; while (a1 <= a0) a1 += TAU;
  add(p.x + p.r * Math.cos(a0), p.y + p.r * Math.sin(a0)); add(p.x + p.r * Math.cos(a1), p.y + p.r * Math.sin(a1));
  for (let q = Math.ceil(a0 / (Math.PI / 2)); q * Math.PI / 2 < a1; q++) { const a = q * Math.PI / 2; add(p.x + p.r * Math.cos(a), p.y + p.r * Math.sin(a)); }
}

function textBox(p, add) {
  const lines = p.s.split('\n');
  const w = p.w || Math.max(...lines.map((l) => l.length)) * p.h * 0.6 * (p.wf || 1);
  const h = p.h * (1 + (lines.length - 1) * 1.667 * (p.ls || 1));
  const x0 = p.ha === 1 ? -w / 2 : p.ha === 2 ? -w : 0;
  const y0 = p.va === 3 ? -h : p.va === 2 ? -h / 2 : 0;
  const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0);
  for (const [u, v] of [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]) add(p.x + u * c - v * s, p.y + u * s + v * c);
}

/** Affine matrices [a b c d e f] (x' = a x + c y + e) for an insert and its array copies. */
function insertMatrices(p) {
  const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0);
  const out = [];
  const nc = Math.min(p.nc || 1, 1000), nr = Math.min(p.nr || 1, 1000);
  for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
    const ox = j * (p.cs || 0), oy = i * (p.rs || 0);
    const tx = p.x + ox * c - oy * s, ty = p.y + ox * s + oy * c;
    const a = c * p.sx, b = s * p.sx, cc = -s * p.sy, d = c * p.sy;
    out.push([a, b, cc, d, tx - (a * (p.bx || 0) + cc * (p.by || 0)), ty - (b * (p.bx || 0) + d * (p.by || 0))]);
  }
  return out;
}

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/** First value of a group code in a flat [code, value, ...] list. */
function tagVal(tags, code, def) {
  for (let k = 0; k < tags.length; k += 2) if (tags[k] === code) return tags[k + 1];
  return def;
}

/** Parse a whole DXF file (Uint8Array). Throws DxfError with a plain message for damaged files. */
function parseDxf(bytes, opts) {
  const s = sniff(bytes);
  if (s.kind === 'dwg') throw new DxfError(`This file is a DWG drawing (${s.version}), not DXF. DXF Viewer opens DXF only. Export it to DXF first.`, 0);
  return new Parser(bytes, opts).parse();
}

module.exports = { parseDxf, Parser, bulgePoints, splinePoints, insertMatrices, mul, tagVal, colorSpec, fmtNum, LIMITS, UNITS };
