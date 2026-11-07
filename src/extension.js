'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage, validateWorkerMessage, sizePlan, fmtSize, dwgInfo, exportName } = require('./core/protocol');
const { sniff } = require('./core/reader');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'dxfViewer.preview';
const VIEW_TYPE_DWG = 'dxfViewer.dwgNotice';
const EXT_ID = 'zovo.dxf-viewer';
const TIMEOUT_MS = 120000;
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('dxfViewer');
  return { maxFileMB: c.get('maxFileMB', 500), background: c.get('background', 'auto'), liveReload: c.get('liveReload', true) };
}

/** Parse in a worker thread so a big drawing never blocks the extension host. */
function parseInWorker(workerPath, data, opts = {}) {
  let worker;
  let timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: opts.heapMB || 4096 } });
    const ms = opts.timeoutMs || TIMEOUT_MS;
    timer = setTimeout(() => { worker.terminate(); reject(new Error(`Reading the drawing took longer than ${Math.round(ms / 1000)} seconds and was stopped.`)); }, ms);
    worker.once('message', (m) => {
      clearTimeout(timer); worker.terminate();
      if (!validateWorkerMessage(m)) return reject(new Error('The DXF reader sent an unexpected reply.'));
      if (m.type === 'error') return reject(new Error(m.message));
      resolve(m.model);
    });
    worker.once('error', (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(/memory/i.test(String(e && e.message)) ? 'The drawing does not fit in memory.' : String((e && e.message) || e))); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`The DXF reader stopped (exit code ${code}).`)); });
    const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : Uint8Array.prototype.slice.call(data).buffer;
    worker.postMessage({ bytes: new Uint8Array(ab) }, [ab]);
  });
  return { promise, cancel: () => { clearTimeout(timer); if (worker) worker.terminate(); } };
}

class DxfEditorProvider {
  constructor(context, kind) { this.context = context; this.kind = kind; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('dxfViewer') };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'dxfViewer'),
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    let job = null;
    const post = (m) => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    const load = async (reload = false) => {
      if (job) job.cancel();
      const stat = await vscode.workspace.fs.stat(uri);
      const s = settings();
      const base = { type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), background: s.background };
      if (this.kind === 'dwg' || /\.dwg$/i.test(name)) {
        let version = '';
        try { const head = await readHead(uri); const k = sniff(head); if (k.kind === 'dwg') version = k.version; } catch { /* the notice works without it */ }
        await post({ ...base, plan: { load: false }, dwg: dwgInfo(version) });
        return;
      }
      const plan = sizePlan(stat.size, s.maxFileMB);
      await post({ ...base, plan });
      if (!plan.load) return;
      const data = await vscode.workspace.fs.readFile(uri);
      const k = sniff(data.subarray(0, 64));
      if (k.kind === 'dwg') { await post({ ...base, plan: { load: false }, dwg: dwgInfo(k.version) }); return; }
      const t0 = Date.now();
      job = parseInWorker(path.join(ctx.extensionUri.fsPath, 'dist', 'worker.js'), data);
      try {
        const model = await job.promise;
        await post({ type: 'model', model, name, sizeText: fmtSize(stat.size), ms: Date.now() - t0, reload });
      } catch (e) {
        await post({ type: 'error', message: e.message });
      } finally { job = null; }
    };

    const doExport = async (msg) => {
      const target = vscode.Uri.joinPath(uri, '..', exportName(name, msg.format));
      const picked = await vscode.window.showSaveDialog({
        defaultUri: target, title: `Export view as ${msg.format.toUpperCase()}`,
        filters: msg.format === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
      });
      if (!picked) return post({ type: 'exported', cancelled: true });
      if (/\.(dxf|dwg)$/i.test(picked.path) || picked.toString() === uri.toString()) {
        return post({ type: 'exported', error: 'Pick a .png or .svg file name. DXF Viewer never writes to drawings.' });
      }
      const bytes = msg.format === 'png'
        ? Buffer.from(msg.data.slice(msg.data.indexOf(',') + 1), 'base64')
        : Buffer.from(msg.data, 'utf8');
      await vscode.workspace.fs.writeFile(picked, bytes);
      return post({ type: 'exported', path: picked.fsPath || picked.path, bytes: bytes.length });
    };

    panel.webview.onDidReceiveMessage(async (raw) => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready' || msg.type === 'reload') { await load(); return; }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'export') { await doExport(msg); return; }
        if (msg.type === 'reopenWith') { await vscode.commands.executeCommand('workbench.action.reopenWithEditor'); return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied', chars: msg.text.length }); }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    // Live reload: when the drawing is saved again (for example from a CAD program), read it again and keep the view.
    let watcher = null, timer = null;
    if (this.kind === 'dxf' && settings().liveReload) {
      try {
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name));
        const changed = () => { clearTimeout(timer); timer = setTimeout(() => { if (!disposed) load(true).catch((e) => post({ type: 'error', message: e && e.message ? e.message : String(e) })); }, 400); };
        watcher.onDidChange(changed); watcher.onDidCreate(changed);
      } catch { watcher = null; /* no watcher for this file system: the view stays as read */ }
    }
    panel.onDidDispose(() => { disposed = true; clearTimeout(timer); if (watcher) watcher.dispose(); if (job) job.cancel(); });
  }
}

async function readHead(uri) {
  if (uri.scheme === 'file') {
    const fs = require('fs');
    const fd = await fs.promises.open(uri.fsPath, 'r');
    try { const b = Buffer.alloc(64); const { bytesRead } = await fd.read(b, 0, 64, 0); return b.subarray(0, bytesRead); } finally { await fd.close(); }
  }
  return (await vscode.workspace.fs.readFile(uri)).subarray(0, 64);
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'dxfViewer', message: (n) => `DXF Viewer has opened ${n} drawings for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'dxfViewer', selfId: EXT_ID });
  const opts = { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DxfEditorProvider(context, 'dxf'), opts),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE_DWG, new DxfEditorProvider(context, 'dwg'), opts),
    vscode.commands.registerCommand('dxfViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#dxfViewer.start`, false)),
    vscode.commands.registerCommand('dxfViewer.openWith', async (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, DxfEditorProvider, parseInWorker, VIEW_TYPE, VIEW_TYPE_DWG, EXT_ID };
