'use strict';
// Parses a DXF file off the extension host thread.
const { parentPort } = require('worker_threads');
const { parseDxf } = require('./core/parse');

parentPort.once('message', ({ bytes }) => {
  try {
    const t0 = Date.now();
    const model = parseDxf(bytes);
    model.parseMs = Date.now() - t0;
    parentPort.postMessage({ type: 'model', model });
  } catch (e) {
    const where = e && Number.isFinite(e.offset) && e.offset > 0 ? ` (near byte ${e.offset})` : '';
    parentPort.postMessage({ type: 'error', message: (e && e.message ? e.message : String(e)) + (e && e.offset !== undefined ? where : '') });
  }
});
