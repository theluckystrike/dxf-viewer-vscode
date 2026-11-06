// DXF Viewer webview: draws the parsed model on a 2D canvas. All file text goes in with textContent or fillText.
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
// The host renders the Sponsor and More free viewers line outside #app (or leaves it out when the setting hides it).
// It is kept here so each new drawing view can take it into its bottom bar.
const supportLine = document.getElementById('zovo-support');

const S = {
  model: null, name: '', sizeText: '', ms: 0,
  view: { cx: 0, cy: 0, s: 1 }, bg: 'dark', hidden: new Set(), measure: false, mpts: [], hover: null, snapPt: null,
  loaded: false, drawMs: 0, draws: 0, rendered: false, cache: new Map(), panel: true, lastExport: null,
};
let canvas, ctx, statusEl, measureEl, layersEl, wrapEl;

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const hex = (rgb) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
const fmt = (v, d = 3) => (Number.isFinite(v) ? (Math.abs(v) >= 1e6 ? v.toExponential(3) : String(Number(v.toFixed(d)))) : '-');

// ---------- colours ----------
function fg() { return S.bg === 'dark' ? '#ffffff' : '#000000'; }
function adjust(rgb) {
  if (S.bg !== 'light') return hex(rgb);
  const r = rgb >> 16 & 255, g = rgb >> 8 & 255, b = rgb & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.75) return hex(rgb);
  const k = 0.55; // darken very light colours so they stay visible on white
  return hex((Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k));
}
function layerColor(li) { const L = S.model.layers[li]; return !L || L.color === -7 ? fg() : adjust(L.color); }
function resolveColor(c, li, inh) {
  if (c >= 0) return adjust(c);
  if (c === -7) return fg();
  if (c === -2) return inh ? inh.color : fg();
  return layerColor(li);
}

// ---------- geometry cache: one set of Path2D batches per container (top level = -1, blocks by index) ----------
function container(ci) {
  let c = S.cache.get(ci);
  if (c) return c;
  const prims = ci < 0 ? S.model.prims : S.model.blocks[ci].prims;
  c = { strokes: new Map(), fills: new Map(), texts: [], inserts: [], points: [] };
  const batch = (map, p, extra) => {
    const key = `${p.l}|${p.c}|${p.lt}|${p.lts}|${extra || ''}`;
    let b = map.get(key);
    if (!b) { b = { l: p.l, c: p.c, lt: p.lt, lts: p.lts, pat: extra, path: new Path2D() }; map.set(key, b); }
    return b;
  };
  for (const p of prims) {
    if (p.t === 'L') { const path = batch(c.strokes, p).path; path.moveTo(p.p[0], p.p[1]); for (let i = 2; i < p.p.length; i += 2) path.lineTo(p.p[i], p.p[i + 1]); }
    else if (p.t === 'A') { const path = batch(c.strokes, p).path; path.moveTo(p.x + p.r * Math.cos(p.a0), p.y + p.r * Math.sin(p.a0)); path.arc(p.x, p.y, p.r, p.a0, p.a1, false); }
    else if (p.t === 'F') {
      const b = batch(c.fills, p, p.pat ? 'pat' : 'solid');
      for (const loop of [p.p, ...(p.holes || [])]) { b.path.moveTo(loop[0], loop[1]); for (let i = 2; i < loop.length; i += 2) b.path.lineTo(loop[i], loop[i + 1]); b.path.closePath(); }
    } else if (p.t === 'T') c.texts.push(p);
    else if (p.t === 'I') c.inserts.push(p);
    else if (p.t === 'P') c.points.push(p);
  }
  S.cache.set(ci, c);
  return c;
}

function matrices(p) {
  const c = Math.cos(p.r || 0), s = Math.sin(p.r || 0), out = [];
  const nc = Math.min(p.nc || 1, 1000), nr = Math.min(p.nr || 1, 1000);
  for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
    const ox = j * (p.cs || 0), oy = i * (p.rs || 0);
    const tx = p.x + ox * c - oy * s, ty = p.y + ox * s + oy * c;
    const a = c * p.sx, b = s * p.sx, cc = -s * p.sy, d = c * p.sy;
    out.push([a, b, cc, d, tx - (a * (p.bx || 0) + cc * (p.by || 0)), ty - (b * (p.bx || 0) + d * (p.by || 0))]);
  }
  return out;
}

const effLayer = (l, inh) => (inh && l === 0 ? inh.layer : l);
function dash(lt, li, lts, k) {
  let idx = lt;
  if (idx === -1) idx = (S.model.layers[li] || {}).lt || 0;
  if (idx <= 0) return null;
  const pat = (S.model.ltypes[idx] || {}).pattern || [];
  if (pat.length < 2) return null;
  const sc = (S.model.ltscale || 1) * (lts || 1);
  const arr = pat.map((v) => Math.max(Math.abs(v) * sc, 0.5 / k));
  if (arr.reduce((a, b) => a + b, 0) * k < 4) return null; // too dense at this zoom: draw solid
  return arr;
}

// ---------- drawing ----------
function drawContainer(g, ci, inh, k, depth) {
  const c = container(ci);
  for (const b of c.fills.values()) {
    const L = effLayer(b.l, inh); if (S.hidden.has(L)) continue;
    const col = resolveColor(b.c, L, inh);
    g.fillStyle = col;
    if (b.pat === 'pat') { g.globalAlpha = 0.22; g.fill(b.path, 'evenodd'); g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 1 / k; g.setLineDash([]); g.stroke(b.path); }
    else g.fill(b.path, 'evenodd');
  }
  for (const b of c.strokes.values()) {
    const L = effLayer(b.l, inh); if (S.hidden.has(L)) continue;
    g.strokeStyle = resolveColor(b.c, L, inh); g.lineWidth = 1 / k;
    g.setLineDash(dash(b.lt === -2 && inh ? inh.lt : b.lt, L, b.lts, k) || []);
    g.stroke(b.path);
  }
  g.setLineDash([]);
  for (const p of c.points) {
    const L = effLayer(p.l, inh); if (S.hidden.has(L)) continue;
    g.fillStyle = resolveColor(p.c, L, inh); g.fillRect(p.x - 1.5 / k, p.y - 1.5 / k, 3 / k, 3 / k);
  }
  for (const p of c.texts) {
    const L = effLayer(p.l, inh); if (S.hidden.has(L)) continue;
    drawText(g, p, resolveColor(p.c, L, inh), k);
  }
  if (depth >= 16) return;
  for (const p of c.inserts) {
    if (!(p.bi >= 0)) continue;
    const L = effLayer(p.l, inh); if (S.hidden.has(L)) continue;
    const sub = { layer: L, color: resolveColor(p.c, L, inh), lt: p.lt === -1 ? ((S.model.layers[L] || {}).lt || 0) : p.lt };
    for (const m of matrices(p)) {
      g.save(); g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      drawContainer(g, p.bi, sub, k * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || k, depth + 1);
      g.restore();
    }
  }
}

const FONT = '100px Arial, Helvetica, sans-serif';
function textLines(g, p) {
  if (p._lines) return p._lines;
  let lines = p.s.split('\n');
  if (p.m && p.w > 0) { // MTEXT reference width: wrap words
    g.save(); g.font = FONT;
    const maxW = p.w / (p.h / 100), out = [];
    for (const line of lines) {
      let cur = '';
      for (const word of line.split(' ')) { const t = cur ? cur + ' ' + word : word; if (cur && g.measureText(t).width > maxW) { out.push(cur); cur = word; } else cur = t; }
      out.push(cur);
    }
    g.restore(); lines = out;
  }
  p._lines = lines;
  return lines;
}
function drawText(g, p, color, k) {
  if (p.h * k < 2) { // too small to read: a faint bar keeps the layout visible
    if (p.h * k < 0.3) return;
    g.save(); g.translate(p.x, p.y); g.rotate(p.r || 0); g.globalAlpha = 0.35; g.fillStyle = color;
    const w = Math.min(p.s.length, 60) * p.h * 0.6, x0 = p.ha === 1 ? -w / 2 : p.ha === 2 ? -w : 0;
    g.fillRect(x0, 0, w, p.h * 0.7); g.restore(); return;
  }
  const lines = textLines(g, p);
  const LH = 166.7 * (p.ls || 1);
  g.save(); g.translate(p.x, p.y); g.rotate(p.r || 0); g.scale(p.h / 100 * (p.wf || 1), -p.h / 100);
  g.font = FONT; g.fillStyle = color;
  g.textAlign = p.ha === 1 ? 'center' : p.ha === 2 ? 'right' : 'left';
  const n = lines.length, total = (n - 1) * LH + 100;
  let y0;
  if (p.va === 3) { g.textBaseline = 'top'; y0 = 0; }
  else if (p.va === 2) { g.textBaseline = 'top'; y0 = -total / 2; }
  else if (p.va === 1) { g.textBaseline = 'top'; y0 = -total; }
  else { g.textBaseline = 'alphabetic'; y0 = -(n - 1) * LH; }
  for (let i = 0; i < n; i++) g.fillText(lines[i], 0, y0 + i * LH);
  g.restore();
}

function viewTransform(g, W, H, dpr, view) {
  const s = view.s;
  g.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (W / 2 - view.cx * s), dpr * (H / 2 + view.cy * s));
}
function bgColor() { return S.bg === 'dark' ? '#1e1e1e' : '#ffffff'; }

function render(g, W, H, dpr, view) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = bgColor(); g.fillRect(0, 0, W * dpr, H * dpr);
  if (!S.model) return;
  viewTransform(g, W, H, dpr, view);
  g.lineJoin = 'round'; g.lineCap = 'round';
  drawContainer(g, -1, null, view.s * dpr, 0);
}

let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(drawNow); }
function drawNow() {
  raf = 0;
  if (!canvas) return;
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, r.width), H = Math.max(1, r.height);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const t0 = performance.now();
  render(ctx, W, H, dpr, S.view);
  overlay(W, H, dpr);
  S.drawMs = Math.round(performance.now() - t0); S.draws++;
  status();
  if (!S.rendered && S.model) { S.rendered = true; vscode.postMessage({ type: 'rendered' }); }
}

function toScreen(x, y) { const r = canvas.getBoundingClientRect(); return [(x - S.view.cx) * S.view.s + r.width / 2, r.height / 2 - (y - S.view.cy) * S.view.s]; }
function toWorld(sx, sy) { const r = canvas.getBoundingClientRect(); return [(sx - r.width / 2) / S.view.s + S.view.cx, (r.height / 2 - sy) / S.view.s + S.view.cy]; }

function overlay(W, H, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const accent = '#3794ff';
  if (S.measure) {
    ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 1.5;
    const pts = S.mpts.slice();
    if (pts.length === 1 && S.hover) pts.push(S.snapPt || S.hover);
    if (pts.length === 2) { const [a, b] = pts.map((p) => toScreen(p[0], p[1])); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    for (const p of pts) { const [x, y] = toScreen(p[0], p[1]); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
    if (S.snapPt) { const [x, y] = toScreen(S.snapPt[0], S.snapPt[1]); ctx.strokeRect(x - 6, y - 6, 12, 12); }
  }
}

// ---------- view ----------
function fit() {
  const e = S.model && S.model.extents;
  const r = canvas.getBoundingClientRect();
  if (!e) { S.view = { cx: 0, cy: 0, s: 1 }; draw(); return; }
  const w = Math.max(e[2] - e[0], 1e-9), h = Math.max(e[3] - e[1], 1e-9);
  S.view = { cx: (e[0] + e[2]) / 2, cy: (e[1] + e[3]) / 2, s: Math.min(r.width / w, r.height / h) * 0.92 };
  if (!Number.isFinite(S.view.s) || S.view.s <= 0) S.view.s = 1;
  draw();
}
function zoomAt(f, sx, sy) {
  const r = canvas.getBoundingClientRect();
  if (sx === undefined) { sx = r.width / 2; sy = r.height / 2; }
  const [wx, wy] = toWorld(sx, sy);
  const s = Math.min(Math.max(S.view.s * f, 1e-12), 1e12);
  S.view = { s, cx: wx - (sx - r.width / 2) / s, cy: wy - (r.height / 2 - sy) / s };
  draw();
}

function nearestSnap(sx, sy) {
  const sn = S.model.snap; let best = null, bd = 100; // 10 px radius, squared
  const r = canvas.getBoundingClientRect(), s = S.view.s;
  for (let i = 0; i < sn.length; i += 2) {
    const x = (sn[i] - S.view.cx) * s + r.width / 2, y = r.height / 2 - (sn[i + 1] - S.view.cy) * s;
    const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
    if (d < bd) { bd = d; best = [sn[i], sn[i + 1]]; }
  }
  return best;
}

function measureText() {
  if (S.mpts.length < 2) return S.measure ? (S.mpts.length ? 'Click the second point.' : 'Click the first point. Points snap to ends, centres and vertices.') : '';
  const [a, b] = S.mpts, dx = b[0] - a[0], dy = b[1] - a[1];
  const u = S.model.unitName ? ' ' + S.model.unitName : ' units';
  const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  return `Distance ${fmt(Math.hypot(dx, dy), 4)}${u}   ΔX ${fmt(dx, 4)}   ΔY ${fmt(dy, 4)}   Angle ${fmt(ang, 2)}°`;
}

function status() {
  if (!statusEl) return;
  const h = S.hover;
  statusEl.textContent = `${h ? `X ${fmt(h[0])}  Y ${fmt(h[1])}` : ''}${h ? '   ' : ''}Zoom ${fmt(S.view.s, 6)} px/unit   Drawn in ${S.drawMs} ms`;
  if (measureEl) { measureEl.textContent = measureText(); measureEl.hidden = !S.measure && S.mpts.length < 2; }
}

function setMeasure(on) {
  S.measure = on; S.mpts = []; S.snapPt = null;
  document.querySelectorAll('button[data-act="measure"]').forEach((b) => b.classList.toggle('on', on));
  if (canvas) canvas.classList.toggle('measuring', on);
  draw();
}
function setBg(bg) {
  S.bg = bg; document.querySelectorAll('button[data-act="bg"]').forEach((b) => { b.textContent = bg === 'dark' ? 'Light background' : 'Dark background'; });
  if (wrapEl) wrapEl.dataset.bg = bg;
  renderLayers(); draw();
}

// ---------- export ----------
function exportPng() {
  const r = canvas.getBoundingClientRect(), scale = 2;
  const c = document.createElement('canvas'); c.width = Math.round(r.width * scale); c.height = Math.round(r.height * scale);
  render(c.getContext('2d'), r.width, r.height, scale, S.view);
  const data = c.toDataURL('image/png');
  S.lastExport = { format: 'png', bytes: Math.round(data.length * 0.75) };
  vscode.postMessage({ type: 'export', format: 'png', data });
}

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch]));
function buildSvg() {
  const r = canvas.getBoundingClientRect(), W = r.width, H = r.height, v = S.view;
  const x0 = v.cx - W / 2 / v.s, y1 = v.cy + H / 2 / v.s;
  const out = []; let count = 0; const MAX = 300000;
  const n = (x) => +x.toFixed(4);
  const P = (m, x, y) => [n((m[0] * x + m[2] * y + m[4] - x0) * v.s), n((y1 - (m[1] * x + m[3] * y + m[5])) * v.s)];
  const walk = (ci, m, inh, depth) => {
    const prims = ci < 0 ? S.model.prims : S.model.blocks[ci].prims;
    for (const p of prims) {
      if (count > MAX) return;
      const L = effLayer(p.l, inh); if (S.hidden.has(L)) continue;
      const col = resolveColor(p.c, L, inh);
      if (p.t === 'L' || p.t === 'F') {
        const loops = p.t === 'F' ? [p.p, ...(p.holes || [])] : [p.p];
        let d = '';
        for (const lp of loops) { for (let i = 0; i < lp.length; i += 2) { const [X, Y] = P(m, lp[i], lp[i + 1]); d += (i ? 'L' : 'M') + X + ' ' + Y; } if (p.t === 'F') d += 'Z'; }
        out.push(p.t === 'F' ? `<path d="${d}" fill="${col}" fill-rule="evenodd"${p.pat ? ' fill-opacity="0.22" stroke="' + col + '"' : ''}/>` : `<path d="${d}" stroke="${col}"/>`); count++;
      } else if (p.t === 'A') {
        let span = p.a1 - p.a0; while (span <= 0) span += Math.PI * 2;
        const seg = Math.max(8, Math.ceil(span / (Math.PI / 90))); let d = '';
        for (let i = 0; i <= seg; i++) { const a = p.a0 + span * i / seg; const [X, Y] = P(m, p.x + p.r * Math.cos(a), p.y + p.r * Math.sin(a)); d += (i ? 'L' : 'M') + X + ' ' + Y; }
        out.push(`<path d="${d}" stroke="${col}"/>`); count++;
      } else if (p.t === 'P') { const [X, Y] = P(m, p.x, p.y); out.push(`<circle cx="${X}" cy="${Y}" r="1.2" fill="${col}"/>`); count++; }
      else if (p.t === 'T') {
        const [X, Y] = P(m, p.x, p.y);
        const sx = Math.hypot(m[0], m[1]), rot = Math.atan2(m[1], m[0]) + (p.r || 0);
        const h = p.h * sx * v.s; if (h < 0.5) continue;
        const lines = p.s.split('\n'), anchor = p.ha === 1 ? 'middle' : p.ha === 2 ? 'end' : 'start';
        const base = p.va === 3 ? 'hanging' : p.va === 2 ? 'middle' : p.va === 1 ? 'text-after-edge' : 'alphabetic';
        const tspans = lines.map((t, i) => `<tspan x="0" dy="${i ? n(h * 1.667 * (p.ls || 1)) : 0}">${xmlEsc(t)}</tspan>`).join('');
        out.push(`<text transform="translate(${X} ${Y}) rotate(${n(-rot * 180 / Math.PI)})" font-size="${n(h)}" fill="${col}" text-anchor="${anchor}" dominant-baseline="${base}">${tspans}</text>`); count++;
      } else if (p.t === 'I' && p.bi >= 0 && depth < 16) {
        const sub = { layer: L, color: col, lt: 0 };
        for (const im of matrices(p)) walk(p.bi, [m[0] * im[0] + m[2] * im[1], m[1] * im[0] + m[3] * im[1], m[0] * im[2] + m[2] * im[3], m[1] * im[2] + m[3] * im[3], m[0] * im[4] + m[2] * im[5] + m[4], m[1] * im[4] + m[3] * im[5] + m[5]], sub, depth + 1);
      }
    }
  };
  walk(-1, [1, 0, 0, 1, 0, 0], null, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}">\n<title>${xmlEsc(S.name)}</title>\n<rect width="100%" height="100%" fill="${bgColor()}"/>\n<g fill="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" font-family="Arial, Helvetica, sans-serif">\n${out.join('\n')}\n</g>\n</svg>\n`;
}
function exportSvg() { const data = buildSvg(); S.lastExport = { format: 'svg', bytes: data.length }; vscode.postMessage({ type: 'export', format: 'svg', data }); }

// ---------- panels ----------
function renderLayers() {
  if (!layersEl) return;
  layersEl.replaceChildren();
  S.model.layers.forEach((L, i) => {
    if (L.name === 'Defpoints' && !L.count) return;
    const cb = el('input', { type: 'checkbox', 'aria-label': `Show layer ${L.name}` });
    cb.checked = !S.hidden.has(i);
    cb.addEventListener('change', () => { if (cb.checked) S.hidden.delete(i); else S.hidden.add(i); draw(); });
    const sw = el('span', { class: 'swatch' }); sw.style.background = layerColor(i);
    const tags = [];
    if (!L.on) tags.push('off in file'); if (L.frozen) tags.push('frozen in file');
    layersEl.append(el('label', { class: 'layer', title: L.name }, cb, sw, el('span', { class: 'lname', text: L.name }), tags.length ? el('span', { class: 'ltag', text: tags.join(', ') }) : null, el('span', { class: 'lcount', text: String(L.count) })));
  });
}

function setAll(show) { S.hidden.clear(); if (!show) S.model.layers.forEach((_, i) => S.hidden.add(i)); renderLayers(); draw(); }

function entityTable(m) {
  const types = [...new Set([...Object.keys(m.counts), ...Object.keys(m.blockCounts)])].sort((a, b) => ((m.counts[b] || 0) - (m.counts[a] || 0)) || a.localeCompare(b));
  const notDrawn = new Set(m.notDrawn);
  const tb = el('tbody');
  for (const t of types) tb.append(el('tr', null, el('td', null, t, notDrawn.has(t) ? el('span', { class: 'ltag', text: ' not drawn' }) : null), el('td', { class: 'num', text: String(m.counts[t] || 0) }), el('td', { class: 'num', text: String(m.blockCounts[t] || 0) })));
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  return el('table', { class: 'ents' }, el('thead', null, el('tr', null, el('th', { text: 'Type' }), el('th', { class: 'num', text: 'Model' }), el('th', { class: 'num', text: 'In blocks' }))), tb,
    el('tfoot', null, el('tr', null, el('td', { text: 'Total' }), el('td', { class: 'num', text: String(total) }), el('td', { class: 'num', text: String(Object.values(m.blockCounts).reduce((a, b) => a + b, 0)) }))));
}

function info(m) {
  const e = m.extents;
  const u = m.unitName ? ` ${m.unitName}` : '';
  const rows = [
    ['Format', `${m.format === 'binary' ? 'Binary' : 'ASCII'} DXF`], ['Version', m.versionName], ['Units', m.unitName || 'not set'],
    ['Size', e ? `${fmt(e[2] - e[0])} x ${fmt(e[3] - e[1])}${u}` : 'empty'], ['Blocks', String(m.blocks.length)], ['Read in', `${S.ms} ms`],
  ];
  const dl = el('dl', { class: 'info' });
  for (const [k, v] of rows) dl.append(el('dt', { text: k }), el('dd', { text: v }));
  return dl;
}

function notes(m) {
  const list = [];
  if (m.notDrawn.length) list.push(`Counted but not drawn: ${m.notDrawn.join(', ')}.`);
  if (m.paperSpace) list.push(`${m.paperSpace} paper space entities are not shown. The view shows model space.`);
  if (m.missingBlocks) list.push(`${m.missingBlocks} inserts point to blocks that are missing or empty.`);
  if (m.endedEarly) list.push('The file ends without the DXF end marker (EOF). It may be cut off; everything up to that point is shown.');
  if (m.truncated) list.push(`The drawing has more than ${m.primTotal.toLocaleString()} shapes. Only the first ones are drawn.`);
  return list.length ? el('div', { class: 'notes' }, ...list.map((t) => el('p', { text: t }))) : null;
}

function button(label, act, fn, title) { return el('button', { 'data-act': act, title: title || label, onclick: fn }, label); }

function showModel(msg) {
  const m = msg.model;
  S.model = m; S.name = msg.name; S.sizeText = msg.sizeText; S.ms = msg.ms; S.cache = new Map(); S.rendered = false;
  S.hidden = new Set(); m.layers.forEach((L, i) => { if (!L.on || L.frozen) S.hidden.add(i); });
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  const head = el('div', { class: 'head' },
    el('div', { class: 'title' }, el('span', { class: 'fname', text: msg.name }), el('span', { class: 'meta', text: `${msg.sizeText} · ${m.format === 'binary' ? 'binary' : 'ASCII'} DXF · ${m.versionName} · ${total.toLocaleString()} entities · ${m.layers.length} layers` })),
    el('div', { class: 'tools' },
      button('Fit', 'fit', fit, 'Fit the drawing (F)'), button('+', 'zoomin', () => zoomAt(1.5), 'Zoom in (+)'), button('−', 'zoomout', () => zoomAt(1 / 1.5), 'Zoom out (-)'),
      button('Measure', 'measure', () => setMeasure(!S.measure), 'Measure a distance (M)'),
      button(S.bg === 'dark' ? 'Light background' : 'Dark background', 'bg', () => setBg(S.bg === 'dark' ? 'light' : 'dark'), 'Switch background (B)'),
      button('Export PNG', 'png', exportPng, 'Save the current view as a PNG image'), button('Export SVG', 'svg', exportSvg, 'Save the current view as an SVG file'),
      button('Panel', 'panel', () => { S.panel = !S.panel; side.hidden = !S.panel; draw(); }, 'Show or hide the side panel')));
  layersEl = el('div', { class: 'layers' });
  const side = el('aside', { class: 'side' },
    el('section', null, el('h3', null, 'Layers', el('span', { class: 'spacer' }), button('All', 'all', () => setAll(true), 'Show all layers'), button('None', 'none', () => setAll(false), 'Hide all layers')), layersEl),
    el('section', null, el('h3', { text: 'Entities' }), entityTable(m)),
    el('section', null, el('h3', { text: 'Drawing' }), info(m)), notes(m));
  side.hidden = !S.panel;
  canvas = el('canvas', { class: 'cad', tabindex: '0', 'aria-label': `Drawing ${msg.name}` });
  ctx = canvas.getContext('2d');
  statusEl = el('div', { class: 'status' });
  measureEl = el('div', { class: 'measure', hidden: '' });
  const copyBtn = button('Copy', 'copymeasure', () => vscode.postMessage({ type: 'copy', text: measureText() }), 'Copy the measurement');
  const bar = el('div', { class: 'bar' }, statusEl, measureEl, copyBtn);
  if (supportLine) bar.append(supportLine);
  wrapEl = el('div', { class: 'canvaswrap' }, canvas, bar);
  wrapEl.dataset.bg = S.bg;
  const toast = el('div', { class: 'toast', hidden: '' });
  app.replaceChildren(head, el('div', { class: 'main' }, side, wrapEl), toast);
  renderLayers();
  bindCanvas();
  new ResizeObserver(() => draw()).observe(wrapEl);
  S.loaded = true;
  requestAnimationFrame(() => fit());
}

function bindCanvas() {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    if (S.measure && e.button === 0) {
      const p = S.snapPt || toWorld(e.offsetX, e.offsetY);
      if (S.mpts.length >= 2) S.mpts = [];
      S.mpts.push(p); draw(); return;
    }
    drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    S.hover = toWorld(e.offsetX, e.offsetY);
    if (drag) { S.view.cx = drag.cx - (e.clientX - drag.x) / S.view.s; S.view.cy = drag.cy + (e.clientY - drag.y) / S.view.s; draw(); return; }
    if (S.measure) { S.snapPt = nearestSnap(e.offsetX, e.offsetY); draw(); } else status();
  });
  const end = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { S.hover = null; status(); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.offsetX, e.offsetY); }, { passive: false });
  canvas.addEventListener('dblclick', () => { if (!S.measure) fit(); });
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'f' || k === 'F') fit(); else if (k === '+' || k === '=') zoomAt(1.5); else if (k === '-') zoomAt(1 / 1.5);
    else if (k === 'm' || k === 'M') setMeasure(!S.measure); else if (k === 'b' || k === 'B') setBg(S.bg === 'dark' ? 'light' : 'dark');
    else if (k === 'Escape') setMeasure(false);
    else if (k.startsWith('Arrow')) { const d = 60 / S.view.s; if (k === 'ArrowLeft') S.view.cx -= d; if (k === 'ArrowRight') S.view.cx += d; if (k === 'ArrowUp') S.view.cy += d; if (k === 'ArrowDown') S.view.cy -= d; draw(); }
    else return;
    e.preventDefault();
  });
}

function toast(text) {
  const t = document.querySelector('.toast'); if (!t) return;
  t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

function showNotice(msg) {
  if (msg.dwg) {
    const d = msg.dwg;
    app.replaceChildren(el('div', { class: 'notice dwg' },
      el('h2', { text: d.title }), d.version ? el('p', { class: 'meta', text: `${msg.name} · ${msg.sizeText} · DWG ${d.version}` }) : el('p', { class: 'meta', text: `${msg.name} · ${msg.sizeText}` }),
      el('p', { text: d.message }), el('h3', { text: 'How to get a DXF file' }), el('ul', null, ...d.steps.map((s) => el('li', { text: s }))),
      el('p', null, button('Reopen with another editor', 'reopen', () => vscode.postMessage({ type: 'reopenWith' })))));
    S.loaded = true; S.notice = 'dwg';
    return;
  }
  app.replaceChildren(el('div', { class: 'notice big' }, el('p', { class: 'meta', text: `${msg.name} · ${msg.sizeText}` }), el('p', { text: msg.plan.message })));
  S.loaded = true; S.notice = 'big';
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    S.name = msg.name; S.sizeText = msg.sizeText;
    if (msg.background === 'light' || msg.background === 'dark') S.bg = msg.background;
    else S.bg = document.body.classList.contains('vscode-light') ? 'light' : 'dark';
    if (msg.dwg || !msg.plan.load) showNotice(msg);
    else app.replaceChildren(el('p', { class: 'loading', text: `Reading ${msg.name} (${msg.sizeText})...` }));
  } else if (msg.type === 'model') showModel(msg);
  else if (msg.type === 'error') {
    if (S.model) { toast(msg.message); return; }
    app.replaceChildren(el('div', { class: 'notice err' }, el('p', { class: 'meta', text: `${S.name} · ${S.sizeText}` }), el('p', { text: `The drawing could not be read. ${msg.message}` }), el('p', null, button('Try again', 'reload', () => vscode.postMessage({ type: 'reload' })))));
    S.loaded = true; S.notice = 'error';
  } else if (msg.type === 'exported') {
    if (msg.cancelled) return;
    toast(msg.error ? msg.error : `Saved ${msg.path} (${Math.round(msg.bytes / 1024)} KB)`);
    S.lastSaved = msg;
  } else if (msg.type === 'copied') toast('Copied the measurement.');
});

// Read-only state for the release check script.
window.dxfViewerProbe = () => ({
  loaded: S.loaded, notice: S.notice || null, bg: S.bg, measure: S.measure, mpts: S.mpts, result: measureText(), view: S.view, draws: S.draws, drawMs: S.drawMs,
  hidden: [...S.hidden].map((i) => S.model && S.model.layers[i].name), layers: S.model ? S.model.layers.length : 0,
  counts: S.model ? S.model.counts : null, lastExport: S.lastExport, lastSaved: S.lastSaved || null,
});

vscode.postMessage({ type: 'ready' });
