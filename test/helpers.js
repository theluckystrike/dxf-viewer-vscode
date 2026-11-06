'use strict';
// Generates the samples once per test file in a temp folder (removed after) with scripts/make-samples.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const samples = require('../scripts/make-samples');

const dirs = [];
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
let cache = null;
function sampleBytes() {
  if (cache) return cache;
  const mech = samples.mechanicalPart();
  cache = {
    floor: new Uint8Array(samples.floorPlan().ascii()), mech: new Uint8Array(mech.ascii()), mechBin: new Uint8Array(mech.binary()),
    r12: new Uint8Array(samples.r12Sample().ascii()), site: new Uint8Array(samples.sitePlan().ascii()),
  };
  return cache;
}
function cleanup() { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
const fixture = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', f)));
module.exports = { tmpDir, sampleBytes, cleanup, fixture, samples };
