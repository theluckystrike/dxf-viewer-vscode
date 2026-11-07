'use strict';
// Pure view math shared by the webview and the tests. No DOM here.

/** Model to paper transform [a b c d e f] of a viewport: scale, twist, and the view centre moved onto the viewport centre. */
function vpMatrix(v) {
  const s = v.h / v.vh, c = Math.cos(v.tw || 0) * s, n = Math.sin(v.tw || 0) * s;
  return [c, n, -n, c, v.x - (c * v.vx - n * v.vy), v.y - (n * v.vx + c * v.vy)];
}

/** Case-insensitive match over the text index, leaving out hidden layers. */
function findTexts(texts, q, hidden) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  return texts.filter((t) => !(hidden && hidden.has(t.l)) && t.s.toLowerCase().includes(needle));
}

/** Corners of a text hit in world units (approximate width: 0.6 x height per character). */
function hitBox(t) {
  const lines = t.s.split('\n');
  const w = t.w || Math.max(...lines.map((l) => l.length)) * t.h * 0.6, h = t.h * (1 + (lines.length - 1) * 1.667);
  const x0 = t.ha === 1 ? -w / 2 : t.ha === 2 ? -w : 0, y0 = t.va === 3 ? -h : t.va === 2 ? -h / 2 : 0;
  const c = Math.cos(t.r || 0), s = Math.sin(t.r || 0), pad = t.h * 0.4;
  return [[x0 - pad, y0 - pad], [x0 + w + pad, y0 - pad], [x0 + w + pad, y0 + h + pad], [x0 - pad, y0 + h + pad]].map(([u, v]) => [t.x + u * c - v * s, t.y + u * s + v * c]);
}

module.exports = { vpMatrix, findTexts, hitBox };
