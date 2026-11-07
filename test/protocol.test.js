'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sizePlan, validateWebviewMessage, validateWorkerMessage, exportName, dwgInfo, fmtSize, MB } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('size plan: 500 MB default limit with a clear message, setting clamps, empty file', () => {
  assert.equal(sizePlan(10 * MB).load, true);
  const big = sizePlan(600 * MB);
  assert.equal(big.load, false);
  assert.equal(big.message, 'This file is 600.0 MB. DXF Viewer opens drawings up to 500 MB so VS Code stays responsive (setting dxfViewer.maxFileMB). The file was not read.');
  assert.equal(sizePlan(600 * MB, 1000).load, true);
  assert.equal(sizePlan(3000 * MB, 99999).limitMB, 2048);
  assert.equal(sizePlan(1, -5).limitMB, 500);
  assert.match(sizePlan(0).message, /empty/);
  assert.equal(fmtSize(1536), '1.5 KB');
});

test('DWG page names the version and points to DXF export', () => {
  const d = dwgInfo('AC1032');
  assert.equal(d.version, 'AC1032 (AutoCAD 2018 format)');
  assert.match(d.message, /does not open it.*Save or export the drawing as DXF/);
  assert.ok(d.steps.some((s) => /ODA File Converter/.test(s)));
  assert.equal(dwgInfo('').version, '');
});

test('webview messages: only known types with checked fields pass', () => {
  for (const t of ['ready', 'rendered', 'reload', 'reopenWith']) assert.deepEqual(validateWebviewMessage({ type: t, extra: 1 }), { ok: true, msg: { type: t } });
  assert.equal(validateWebviewMessage({ type: 'eval', code: '1' }).ok, false);
  assert.equal(validateWebviewMessage(null).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'pdf', data: 'x' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: 'data:text/html;base64,AAAA' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'png', data: 'data:image/png;base64,iVBORw0KGgo=' }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'svg', data: '<?xml version="1.0"?><svg/>' }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'svg', data: 'rm -rf /' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'copy', text: 'Distance 5 mm' }).ok, true);
  assert.equal(validateWebviewMessage({ type: 'copy', text: 'x'.repeat(200001) }).ok, false);
  assert.equal(validateWorkerMessage({ type: 'model', model: {} }), true);
  assert.equal(validateWorkerMessage({ type: 'model' }), false);
  assert.equal(validateWorkerMessage({ type: 'error', message: 'x' }), true);
});

test('export names never point at the drawing', () => {
  assert.equal(exportName('plan.dxf', 'png'), 'plan.png');
  assert.equal(exportName('PART.DXF', 'svg'), 'PART.svg');
  assert.equal(exportName('.dxf', 'svg'), 'drawing.svg');
});

test('HTML: strict CSP, nonce script, escaped title', () => {
  // The footer's Rate link is a click-only link to the Marketplace review page, not a loaded resource.
  const rateLink = / href=\"https:\/\/marketplace\.visualstudio\.com\/items\?itemName=[^\"]+#review-details\"/g;
  const h = buildHtml({ cspSource: 'https://x', scriptUri: 'https://x/w.js', styleUri: 'https://x/s.css', title: '<img src=x onerror=alert(1)>.dxf', nonce: 'abc' }).replace(rateLink, '');
  assert.match(h, /default-src 'none'/);
  assert.match(h, /script-src 'nonce-abc'/);
  assert.doesNotMatch(h, /unsafe-inline|unsafe-eval|connect-src|https?:\/\/(?!x)/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;\.dxf/);
});

test('webview code: no innerHTML, eval, fetch or remote URLs; every posted type passes validation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  const types = [...src.matchAll(/postMessage\(\{ type: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(types.length >= 6);
  for (const t of new Set(types)) {
    const sample = t === 'export' ? { type: t, format: 'svg', data: '<svg/>' } : t === 'copy' ? { type: t, text: 'x' } : { type: t };
    assert.equal(validateWebviewMessage(sample).ok, true, t);
  }
});

test('host code: no network modules and no writes outside the export path', () => {
  const dir = path.join(__dirname, '..', 'src');
  const all = ['extension.js', 'worker.js', 'html.js', 'core/parse.js', 'core/reader.js', 'core/protocol.js', 'core/text.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(all, /require\('(https?|net|tls|dgram|child_process)'\)|fetch\(/);
  const ext = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
  assert.equal((ext.match(/writeFile\(/g) || []).length, 1, 'one write: the export the user picked');
});

test('webview code: no local name shadows the toast() helper (a reload once threw "toast is not a function")', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.equal((src.match(/\b(const|let|var)\s+toast\b/g) || []).length, 0);
});
