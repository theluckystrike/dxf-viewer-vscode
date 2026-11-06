'use strict';
// The extension host on a mocked VS Code API, with the real worker thread from dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { tmpDir, sampleBytes, cleanup } = require('./helpers');

const tmp = tmpDir('dxf-ext-');
test.after(cleanup);
const root = path.join(__dirname, '..');

const state = { config: { maxFileMB: 500, askForRating: true, background: 'auto' }, clipboard: '', sizeOverride: null, reads: 0, saveTo: null, writes: [], commands: [] };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: (s) => ({ toString: () => s }) },
  workspace: {
    workspaceFolders: [{ uri: uriOf('/ws') }],
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: {
      stat: async (u) => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }),
      readFile: async (u) => { state.reads++; return fs.readFileSync(u.fsPath); },
      writeFile: async (u, b) => { state.writes.push([u.fsPath, b.length]); fs.writeFileSync(u.fsPath, b); },
    },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
    showSaveDialog: async (o) => { state.lastDialog = o; return state.saveTo ? uriOf(state.saveTo) : undefined; },
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async (...a) => { state.commands.push(a); } },
  env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: (u) => 'https://res' + u.path, postMessage: async (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; }, onDidReceiveMessage: (h) => { handler = h; } },
    onDidDispose: (h) => { dispose = h; },
  };
  return { panel, sent, send: (m) => handler(m), close: () => dispose() };
}
const ctxOf = () => ({ extensionUri: uriOf(root), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } });
async function open(file, kind = 'dxf') {
  const prov = new ext.DxfEditorProvider(ctxOf(), kind);
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return f;
}
const s = sampleBytes();
const floor = path.join(tmp, 'floor-plan.dxf'); fs.writeFileSync(floor, s.floor);
const bin = path.join(tmp, 'part-binary.dxf'); fs.writeFileSync(bin, s.mechBin);
const dwg = path.join(tmp, 'house.dwg'); fs.writeFileSync(dwg, Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(100)]));
const dwgNamedDxf = path.join(tmp, 'renamed.dxf'); fs.writeFileSync(dwgNamedDxf, Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(100)]));
const broken = path.join(tmp, 'broken.dxf'); fs.writeFileSync(broken, 'this is not a drawing\nat all\n');

test('activate registers the DXF editor, the DWG notice and the commands; manifest matches', () => {
  ext.activate(ctxOf());
  assert.deepEqual(vscodeMock.window.registered.map((r) => r[0]), ['dxfViewer.preview', 'dxfViewer.dwgNotice']);
  assert.deepEqual(vscodeMock.commands.list.sort(), ['dxfViewer.moreViewers', 'dxfViewer.openWalkthrough', 'dxfViewer.openWith', 'dxfViewer.supportDeveloper']);
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'dxf-viewer'); assert.equal(pkg.publisher, 'zovo'); assert.equal(pkg.version, '0.1.1'); assert.equal(`${pkg.publisher}.${pkg.name}`, ext.EXT_ID);
  assert.ok(pkg.displayName.length <= 45 && pkg.displayName.toLowerCase().startsWith('dxf viewer'));
  assert.ok(pkg.keywords.length <= 30);
  assert.deepEqual(pkg.contributes.customEditors.map((e) => [e.viewType, e.selector[0].filenamePattern, e.priority]), [['dxfViewer.preview', '*.dxf', 'default'], ['dxfViewer.dwgNotice', '*.dwg', 'default']]);
  assert.equal(pkg.contributes.configuration.properties['dxfViewer.maxFileMB'].default, 500);
});

test('ready: init, then the model from the worker; webview roots are dist and media only', async () => {
  const f = await open(floor);
  assert.deepEqual(f.panel.webview.options.localResourceRoots.map((u) => path.basename(u.path)), ['dist', 'media']);
  await f.send({ type: 'ready' });
  assert.equal(f.sent[0].type, 'init'); assert.equal(f.sent[0].plan.load, true);
  const m = f.sent.find((x) => x.type === 'model');
  assert.ok(m, JSON.stringify(f.sent.map((x) => x.type)));
  assert.equal(m.model.counts.INSERT, 25); assert.equal(m.model.layers.length, 11);
});

test('binary DXF opens through the worker', async () => {
  const f = await open(bin);
  await f.send({ type: 'ready' });
  const m = f.sent.find((x) => x.type === 'model');
  assert.equal(m.model.format, 'binary'); assert.equal(m.model.counts.DIMENSION, 4);
});

test('over the size limit: message, and the file is never read', async () => {
  state.sizeOverride = 600 * 1024 * 1024; const before = state.reads;
  const f = await open(floor);
  await f.send({ type: 'ready' });
  state.sizeOverride = null;
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].plan.load, false); assert.match(f.sent[0].plan.message, /600\.0 MB.*up to 500 MB/);
  assert.equal(state.reads, before);
});

test('DWG: the notice page with the version, never parsed; a DWG renamed to .dxf gets the same page', async () => {
  const before = state.reads;
  const f = await open(dwg, 'dwg');
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].dwg.version, 'AC1027 (AutoCAD 2013 format)');
  assert.equal(state.reads, before, 'only the 64-byte head is read, not the file');
  const g = await open(dwgNamedDxf);
  await g.send({ type: 'ready' });
  assert.equal(g.sent[g.sent.length - 1].dwg.version, 'AC1032 (AutoCAD 2018 format)');
  await g.send({ type: 'reopenWith' });
  assert.deepEqual(state.commands.pop(), ['workbench.action.reopenWithEditor']);
});

test('a damaged file gives an error message', async () => {
  const f = await open(broken);
  await f.send({ type: 'ready' });
  const e = f.sent.find((x) => x.type === 'error');
  assert.match(e.message, /should hold a group code/);
});

test('export: PNG and SVG go to the picked file; a .dxf target is refused; cancel writes nothing', async () => {
  const f = await open(floor);
  state.saveTo = path.join(tmp, 'out.png');
  await f.send({ type: 'export', format: 'png', data: 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64') });
  assert.equal(path.basename(state.lastDialog.defaultUri.path), 'floor-plan.png');
  assert.equal(fs.readFileSync(state.saveTo, 'utf8'), 'PNGDATA');
  state.saveTo = path.join(tmp, 'out.svg');
  await f.send({ type: 'export', format: 'svg', data: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>' });
  assert.match(fs.readFileSync(state.saveTo, 'utf8'), /<svg/);
  const n = state.writes.length;
  state.saveTo = floor;
  await f.send({ type: 'export', format: 'svg', data: '<svg/>' });
  assert.equal(state.writes.length, n); assert.match(f.sent[f.sent.length - 1].error, /never writes to drawings/);
  assert.deepEqual([...fs.readFileSync(floor)].length, s.floor.length);
  state.saveTo = null;
  await f.send({ type: 'export', format: 'png', data: 'data:image/png;base64,AAAA' });
  assert.equal(state.writes.length, n);
});

test('rendered counts once per tab, copy works, unknown messages are dropped, nothing is posted after dispose', async () => {
  const f = await open(floor);
  await f.send({ type: 'rendered' }); await f.send({ type: 'rendered' });
  await f.send({ type: 'copy', text: 'Distance 6000 mm' });
  assert.equal(state.clipboard, 'Distance 6000 mm');
  const n = f.sent.length;
  await f.send({ type: 'runCommand', command: 'x' });
  assert.equal(f.sent.length, n);
  f.close();
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, n);
});

test('worker timeout stops the job with a message', async () => {
  const job = ext.parseInWorker(path.join(root, 'dist', 'worker.js'), new Uint8Array(Buffer.from('0\nEOF\n')), { timeoutMs: 1 });
  await assert.rejects(job.promise, /longer than 0 seconds|stopped/);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('dxfViewer.supportDeveloper') && ids.includes('dxfViewer.moreViewers'));
  assert.equal(pkg.contributes.configuration.properties['dxfViewer.showSupportLinks'].default, true);
  assert.ok(support.otherProducts(ext.EXT_ID).every((p) => p.id !== ext.EXT_ID));
});

test('support: the footer shows by default and dxfViewer.showSupportLinks=false hides it', async () => {
  for (const [value, shown] of [[undefined, true], [false, false]]) {
    if (value === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = value;
    try {
      const f = await open(floor);
      assert.equal(/id="zovo-support"/.test(f.panel.webview.html), shown, String(value));
      assert.equal(f.panel.webview.html.includes('command:dxfViewer.moreViewers'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['dxfViewer.supportDeveloper', 'dxfViewer.moreViewers', 'workbench.action.openSettings']);
      f.close();
    } finally { delete state.config.showSupportLinks; }
  }
});
