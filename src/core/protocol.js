'use strict';
// Shared by the extension host, the worker and the tests. No vscode import here.

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 500;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Files over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 2048) : DEFAULT_MAX_MB;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This file is ${fmtSize(size)}. DXF Viewer opens drawings up to ${limitMB} MB so VS Code stays responsive (setting dxfViewer.maxFileMB). The file was not read.`,
    };
  }
  if (size === 0) return { load: false, limitMB, message: 'The file is empty. There is no drawing to show.' };
  return { load: true, limitMB };
}

/** Text for the DWG page. `version` is the AC10xx code from the first 6 bytes, if any. */
const DWG_RELEASES = { AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018' };
function dwgInfo(version) {
  const rel = DWG_RELEASES[version];
  return {
    title: 'DWG files are not supported',
    version: version ? `${version}${rel ? ` (${rel} format)` : ''}` : '',
    message: 'DXF Viewer reads DXF, the open exchange format for CAD drawings. DWG is a closed binary format, and there is no permissively licensed reader for it, so this extension does not open it. Save or export the drawing as DXF, then open the .dxf file here.',
    steps: [
      'AutoCAD, AutoCAD LT or DWG TrueView: Save As (or DXFOUT), then pick an AutoCAD DXF file type.',
      'BricsCAD, ZWCAD, DraftSight: Save As, then pick DXF.',
      'LibreCAD, QCAD or FreeCAD: open the DWG and save it as DXF.',
      'The free ODA File Converter turns a folder of DWG files into DXF in one go.',
    ],
  };
}

const str = (v, max) => typeof v === 'string' && v.length <= max;
const MAX_EXPORT = 64 * MB;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'rendered':
    case 'reload':
    case 'reopenWith':
      return { ok: true, msg: { type: m.type } };
    case 'export': {
      if (m.format !== 'png' && m.format !== 'svg') return { ok: false };
      if (!str(m.data, MAX_EXPORT)) return { ok: false };
      if (m.format === 'png' && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(m.data.slice(0, 64) + m.data.slice(-8))) return { ok: false };
      if (m.format === 'svg' && !m.data.startsWith('<?xml') && !m.data.startsWith('<svg')) return { ok: false };
      return { ok: true, msg: { type: 'export', format: m.format, data: m.data } };
    }
    case 'copy':
      if (!str(m.text, 100000)) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    default:
      return { ok: false };
  }
}

/** Messages the worker may send back to the host. */
function validateWorkerMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'model') return !!m.model && typeof m.model === 'object';
  if (m.type === 'error') return typeof m.message === 'string';
  return false;
}

/** Export file name next to the drawing: plan.dxf -> plan.png. Never the drawing itself. */
function exportName(fileName, format) {
  const base = String(fileName).replace(/\.(dxf|dwg)$/i, '');
  return `${base || 'drawing'}.${format}`;
}

module.exports = { MB, DEFAULT_MAX_MB, fmtSize, sizePlan, dwgInfo, validateWebviewMessage, validateWorkerMessage, exportName, MAX_EXPORT };
