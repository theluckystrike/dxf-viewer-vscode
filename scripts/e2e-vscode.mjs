// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `dxf-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 600), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = (expr) => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.dxfViewerProbe ? window.dxfViewerProbe() : null)`));
const getWv = async (title) => vs.waitFor(async () => (await vs.webviews()).find((w) => w.title === title && w.w > 0), 20000);
const open = async (file) => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const loaded = async () => { const ok = await vs.waitFor(async () => { const p = await probe(); return p?.loaded && (p.notice || p.draws > 0); }, 30000, 200); if (!ok) throw new Error('not loaded: ' + await E(`document.body.innerText.slice(0, 400)`)); await sleep(400); return probe(); };
const text = (sel) => E(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const btn = (act) => `document.querySelector('button[data-act="${act}"]')`;
const painted = () => E(`(() => { const c = document.querySelector('canvas.cad'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; const r0 = d[0], g0 = d[1], b0 = d[2]; let n = 0; for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 40) n++; return n; })()`);
const canvasBox = async () => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('canvas.cad').getBoundingClientRect())`)); return { x: off.x + b.x, y: off.y + b.y, w: b.width, h: b.height }; };
const worldToPage = async (x, y) => { const p = await probe(); const b = await canvasBox(); return [b.x + (x - p.view.cx) * p.view.s + b.w / 2, b.y + b.h / 2 - (y - p.view.cy) * p.view.s]; };
const mouse = (type, x, y, extra = {}) => vs.s.send('Input.dispatchMouseEvent', { type, x, y, ...extra }, vs.wb);
const saveVia = async (target) => {
  const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); return i && i.offsetParent ? i.value : null; })()`), 8000, 150);
  if (!dlg) throw new Error('save dialog did not open');
  await vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); i.focus(); i.select(); })()`);
  await vs.type(target); await sleep(500); await vs.key('Enter', 'Enter');
  return dlg;
};

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('floor-plan.dxf opens by default: drawing painted, layers panel, off/frozen layers start hidden', async () => {
    const ms = await open('floor-plan.dxf'); const p = await loaded();
    const head = await text('.head .meta');
    const px = await painted();
    if (p.layers !== 11 || !p.hidden.includes('ELECTRICAL') || !p.hidden.includes('OLD-LAYOUT') || px < 2000 || !/ASCII DXF · AutoCAD 2000 · 68 entities/.test(head)) throw new Error(JSON.stringify({ p, head, px }));
    const ents = await E(`[...document.querySelectorAll('table.ents tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
    await shot('floor-plan');
    return { openMs: ms, drawMs: p.drawMs, paintedSamples: px, header: head, entities: ents };
  });
  await step('layer toggle by a real click hides FURNITURE and shows it again', async () => {
    const before = await painted();
    const cb = `[...document.querySelectorAll('label.layer')].find(l => l.querySelector('.lname').textContent === 'FURNITURE').querySelector('input')`;
    await vs.wvClick(wv, cb); await sleep(400);
    const p = await probe(); const after = await painted();
    await vs.wvClick(wv, cb); await sleep(400);
    const back = await painted(); const p2 = await probe();
    if (!p.hidden.includes('FURNITURE') || after >= before || p2.hidden.includes('FURNITURE') || Math.abs(back - before) / before > 0.03) throw new Error(JSON.stringify({ before, after, back, hidden: p.hidden }));
    return { paintedBefore: before, hiddenPainted: after, restored: back };
  });
  await step('wheel zoom at the cursor, drag to pan, Fit button restores the view', async () => {
    const p0 = await probe(); const b = await canvasBox();
    const cx = b.x + b.w * 0.35, cy = b.y + b.h * 0.45;
    await mouse('mouseMoved', cx, cy);
    for (let i = 0; i < 4; i++) { await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: -240 }); await sleep(80); }
    await sleep(300); const p1 = await probe();
    await mouse('mousePressed', cx, cy, { button: 'left', clickCount: 1 }); for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', cx + k * 20, cy + k * 10, { button: 'left' }); await sleep(20); } await mouse('mouseReleased', cx + 160, cy + 80, { button: 'left', clickCount: 1 });
    await sleep(300); const p2 = await probe();
    await shot('zoomed');
    await vs.wvClick(wv, btn('fit')); await sleep(400); const p3 = await probe();
    if (!(p1.view.s > p0.view.s * 2) || Math.abs(p2.view.cx - p1.view.cx) < 1 || Math.abs(p3.view.s - p0.view.s) / p0.view.s > 1e-6) throw new Error(JSON.stringify({ p0: p0.view, p1: p1.view, p2: p2.view, p3: p3.view }));
    return { fitScale: p0.view.s, zoomed: p1.view.s, pannedBy: [p2.view.cx - p1.view.cx, p2.view.cy - p1.view.cy] };
  });
  await step('measure: two clicks snap to the outer wall corners, 14000 mm; Copy puts it on the clipboard', async () => {
    await vs.wvClick(wv, btn('measure')); await sleep(300);
    const [x1, y1] = await worldToPage(3, 4); await mouse('mouseMoved', x1 + 3, y1 - 2); await sleep(150); await vs.click(x1 + 3, y1 - 2);
    const [x2, y2] = await worldToPage(13996, 3); await mouse('mouseMoved', x2 - 2, y2 - 2); await sleep(150); await vs.click(x2 - 2, y2 - 2);
    await sleep(300); const p = await probe();
    const bar = await text('.measure');
    await shot('measure');
    if (!/^Distance 14000 mm\s+ΔX 14000\s+ΔY 0\s+Angle 0°/.test(bar)) throw new Error(JSON.stringify({ bar, mpts: p.mpts }));
    // The macOS clipboard is shared with other agents on this host, so retry the read and also check the webview toast.
    let clip = '', toastText = '';
    for (let attempt = 0; attempt < 3 && !clip.startsWith('Distance 14000 mm'); attempt++) {
      await vs.wvClick(wv, btn('copymeasure')); await sleep(300);
      toastText = await text('.toast');
      clip = execSync('pbpaste', { encoding: 'utf8' });
    }
    if (!clip.startsWith('Distance 14000 mm') || toastText !== 'Copied the measurement.') throw new Error('clipboard: ' + clip + ' toast: ' + toastText);
    await vs.key('Escape', 'Escape'); await sleep(200);
    const off = await probe();
    return { result: bar, clipboard: clip, toast: toastText, measureOffAfterEsc: !off.measure };
  });
  await step('light background by the toolbar button', async () => {
    await vs.wvClick(wv, btn('bg')); await sleep(400);
    const p = await probe();
    const corner = await E(`Array.from(document.querySelector('canvas.cad').getContext('2d').getImageData(2, 2, 1, 1).data).slice(0, 3).join(',')`);
    await shot('light-background');
    await vs.wvClick(wv, btn('bg')); await sleep(300);
    if (p.bg !== 'light' || corner !== '255,255,255') throw new Error(JSON.stringify({ bg: p.bg, corner }));
    return { bg: p.bg, cornerPixel: corner };
  });
  await step('Export SVG through the save dialog writes a valid SVG next to the drawing', async () => {
    const target = path.join(ws, 'export-floor.svg'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('svg'));
    const suggested = await saveVia(target);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 10000);
    if (!ok) throw new Error('svg not written; dialog had ' + suggested);
    const svg = fs.readFileSync(target, 'utf8');
    const paths = (svg.match(/<path /g) || []).length, texts = (svg.match(/<text /g) || []).length;
    if (!svg.startsWith('<?xml') || paths < 100 || texts < 5 || !/LIVING \/ DINING/.test(svg)) throw new Error(svg.slice(0, 300));
    const toast = await vs.waitFor(() => text('.toast'), 4000);
    fs.rmSync(target);
    return { suggested, bytes: svg.length, paths, texts, toast };
  });
  await step('Export PNG through the save dialog writes a PNG', async () => {
    const target = path.join(ws, 'export-floor.png'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('png'));
    await saveVia(target);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 10000);
    if (!ok) throw new Error('png not written');
    const head = fs.readFileSync(target).subarray(0, 24);
    const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
    fs.copyFileSync(target, path.join(shotDir, 'export-floor-plan.png'));
    fs.rmSync(target);
    if (head.toString('latin1', 1, 4) !== 'PNG' || w < 800) throw new Error(JSON.stringify({ w, h }));
    return { width: w, height: h };
  });
  await step('mechanical-part-binary.dxf: binary DXF with blocks, spline, ellipse, linetypes and dimensions', async () => {
    await open('mechanical-part-binary.dxf'); const p = await loaded();
    const head = await text('.head .meta');
    if (!/binary DXF/.test(head) || p.counts.DIMENSION !== 4 || await painted() < 1000) throw new Error(JSON.stringify({ head, p }));
    await shot('mechanical-binary');
    return { header: head };
  });
  await step('site-plan.dxf: 5,700 entities, entity table and draw time', async () => {
    await open('site-plan.dxf'); const p = await loaded();
    const rows = await E(`[...document.querySelectorAll('table.ents tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
    const b = await canvasBox(); const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    for (let i = 0; i < 6; i++) { await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: -240 }); await sleep(60); }
    await sleep(400); const p2 = await probe();
    await shot('site-plan-zoomed');
    if (!/INSERT 3241/.test(rows) || p.drawMs > 1500) throw new Error(JSON.stringify({ rows, drawMs: p.drawMs }));
    return { entities: rows, drawMsFit: p.drawMs, drawMsZoomed: p2.drawMs };
  });
  await step('r12-tags.dxf: R12 polylines and attribute values', async () => {
    await open('r12-tags.dxf'); const p = await loaded();
    const head = await text('.head .meta');
    if (!/R11\/R12/.test(head) || p.counts.POLYLINE !== 2) throw new Error(JSON.stringify({ head, p }));
    return { header: head };
  });
  await step('not-supported.dwg: DWG page with the version and the DXF export steps', async () => {
    await open('not-supported.dwg'); const p = await loaded();
    const t = await E(`document.querySelector('.notice.dwg').innerText`);
    await shot('dwg-notice');
    if (p.notice !== 'dwg' || !/DWG files are not supported/.test(t) || !/AC1032 \(AutoCAD 2018 format\)/.test(t) || !/ODA File Converter/.test(t)) throw new Error(t);
    return { text: t.split('\n').slice(0, 3).join(' / ') };
  });
  await step('huge.dxf (sparse 600 MB): clear message, the file is not read', async () => {
    await open('huge.dxf'); const p = await loaded();
    const t = await text('.notice.big');
    await shot('over-500mb-message');
    if (p.notice !== 'big' || !/600\.0 MB\. DXF Viewer opens drawings up to 500 MB.*not read/.test(t)) throw new Error(t);
    return { notice: t };
  });
  await step('broken.dxf: plain error message', async () => {
    await open('broken.dxf'); const p = await loaded();
    const t = await text('.notice.err');
    if (p.notice !== 'error' || !/could not be read\. Line 1 should hold a group code/.test(t)) throw new Error(t);
    return { notice: t };
  });
  // ---- 0.2.0: sheets, pattern hatches, Find text, live reload (house-sheets.dxf from scripts/make_sheet_sample.py) ----
  const pickSheet = async (i) => { await E(`(() => { const s = document.querySelector('select[data-act="sheet"]'); s.value = '${i}'; s.dispatchEvent(new Event('change')); })()`); await sleep(500); return probe(); };
  if (fs.existsSync(path.join(ws, 'house-sheets.dxf'))) {
    await step('house-sheets.dxf: model space with three pattern hatches drawn as lines; Sheet list has the two layouts', async () => {
      await open('house-sheets.dxf'); const p = await loaded();
      const opts = await E(`[...document.querySelectorAll('select[data-act="sheet"] option')].map(o => o.textContent).join('|')`);
      const px = await painted();
      const b = await canvasBox(); const [hx, hy] = await worldToPage(7900, 2500);
      for (let i = 0; i < 3; i++) { await mouse('mouseWheel', hx, hy, { deltaX: 0, deltaY: -240 }); await sleep(80); }
      await sleep(300); await shot('hatch-zoom');
      await vs.wvClick(wv, btn('fit')); await sleep(300);
      if (p.hatch.patterns !== 3 || p.hatch.tinted !== 0 || opts !== 'Model|A-101 Ground floor|A-501 Bath detail' || px < 2000) throw new Error(JSON.stringify({ hatch: p.hatch, opts, px }));
      return { hatch: p.hatch, sheetOptions: opts, paintedSamples: px, box: b };
    });
    await step('Sheet A-101: paper, title block and the 1:100 viewport are painted', async () => {
      const p = await pickSheet(0); const px = await painted();
      const vp = await worldToPage(150, 160); // viewport centre, model point (7000, 4300)
      await shot('sheet-a101');
      const notes = await text('.notes');
      if (p.sheet !== 0 || px < 1500 || !/2 paper space sheets with 3 viewports/.test(notes)) throw new Error(JSON.stringify({ sheet: p.sheet, px, notes }));
      return { sheet: p.sheets[p.sheet], paintedSamples: px, notes, viewportCentreOnPage: vp };
    });
    await step('Sheet A-501: FURNITURE frozen in the detail viewport only, key plan viewport shows it', async () => {
      const p = await pickSheet(1); const px = await painted();
      await shot('sheet-a501');
      if (p.sheet !== 1 || px < 1500) throw new Error(JSON.stringify({ sheet: p.sheet, px }));
      return { sheet: p.sheets[p.sheet], paintedSamples: px };
    });
    await step('Export SVG of the sheet: clip paths for the viewports and the title block text', async () => {
      const target = path.join(ws, 'export-sheet.svg'); fs.rmSync(target, { force: true });
      await pickSheet(0);
      await vs.wvClick(wv, btn('svg')); await saveVia(target);
      const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 10000);
      if (!ok) throw new Error('svg not written');
      const svg = fs.readFileSync(target, 'utf8'); fs.rmSync(target);
      const clips = (svg.match(/<clipPath /g) || []).length;
      if (clips !== 1 || !/GROUND FLOOR PLAN/.test(svg) || !/LIVING \/ DINING/.test(svg)) throw new Error(svg.slice(0, 300));
      return { bytes: svg.length, clipPaths: clips };
    });
    await step('Find: Cmd+F focuses the box, "V-7" finds the block attribute and frames it; Enter cycles', async () => {
      await pickSheet(-1); await sleep(4200); // let the export toast close before the picture
      await vs.wvClick(wv, `document.querySelector('canvas.cad')`); await sleep(200);
      await vs.key('f', 'KeyF', 4, 70); await sleep(300);
      const focused = await E(`document.activeElement && document.activeElement.className`);
      await vs.type('V-7'); await sleep(500);
      const p = await probe(); const count = await text('.findcount');
      await shot('find-v7');
      await vs.key('Enter', 'Enter', 0, 13); await sleep(300); const p2 = await probe();
      await E(`(() => { const i = document.querySelector('input.find'); i.select(); })()`); await vs.type('zzz-none'); await sleep(300);
      const none = await text('.findcount');
      await vs.key('Escape', 'Escape', 0, 27); await sleep(200);
      if (focused !== 'find' || p.find.hits !== 1 || p.find.hit !== 'V-7' || count !== '1 of 1' || p2.find.i !== 0 || none !== 'No match' || Math.abs(p.view.cx - 6400) > 400) throw new Error(JSON.stringify({ focused, find: p.find, count, none, view: p.view }));
      return { focused, find: p.find, count, view: p.view, noMatch: none };
    });
    await step('Live reload: the file changes on disk, the view reads it again and keeps the sheet', async () => {
      const f = path.join(ws, 'house-sheets.dxf'); const orig = fs.readFileSync(f);
      await pickSheet(1); const before = await probe();
      fs.writeFileSync(f, orig.toString('latin1').replace('PUMP P-1 (UNDER SINK)', 'PUMP P-2 (UNDER SINK)'), 'latin1');
      const p = await vs.waitFor(async () => { const q = await probe(); return q.reloads >= 1 ? q : null; }, 10000, 200);
      const toastText = await text('.toast');
      await pickSheet(-1);
      await E(`(() => { const i = document.querySelector('input.find'); i.value = 'P-2'; i.dispatchEvent(new Event('input')); })()`); await sleep(300);
      const hit = await probe();
      fs.writeFileSync(f, orig); await vs.waitFor(async () => (await probe()).reloads >= 2, 10000, 200);
      if (!p || p.sheet !== before.sheet || hit.find.hits !== 1 || !/changed on disk/.test(toastText)) throw new Error(JSON.stringify({ p, toastText, hit: hit.find }));
      return { reloads: p.reloads, keptSheet: p.sheets[p.sheet], toast: toastText, newTextFound: hit.find.hit };
    });
  }
  await step('Default Light Modern theme: auto background follows the theme', async () => {
    const sf = path.join(vs.ud, 'User', 'settings.json');
    const set = (theme) => { const j = JSON.parse(fs.readFileSync(sf, 'utf8')); j['workbench.colorTheme'] = theme; fs.writeFileSync(sf, JSON.stringify(j, null, 1)); };
    set('Default Light Modern'); await sleep(2000);
    await open('mechanical-part.dxf'); const p = await loaded();
    await shot('light-theme-mechanical');
    set('Default Dark Modern'); await sleep(800);
    if (p.bg !== 'light') throw new Error(JSON.stringify(p));
    return { bg: p.bg };
  });
} finally {
  R.console = vs.console.filter((c) => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /dxf|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map((s) => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
