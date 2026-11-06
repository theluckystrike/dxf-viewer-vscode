'use strict';
// Streams group code / value pairs out of an ASCII or binary DXF file without building a big tag array.
// No vscode import: runs in the worker and under node --test.

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

/** Value kind of a group code, from the DXF reference. 's' string, 'd' double, 'i' int16, 'l' int32, 'q' int64, 'b' bool, 'x' binary chunk. */
function codeKind(c) {
  if (c >= 0 && c <= 9) return 's';
  if (c >= 10 && c <= 59) return 'd';
  if (c >= 60 && c <= 79) return 'i';
  if (c >= 90 && c <= 99) return 'l';
  if (c === 100 || c === 101 || c === 102 || c === 105) return 's';
  if (c >= 110 && c <= 149) return 'd';
  if (c >= 160 && c <= 169) return 'q';
  if (c >= 170 && c <= 179) return 'i';
  if (c >= 210 && c <= 239) return 'd';
  if (c >= 270 && c <= 289) return 'i';
  if (c >= 290 && c <= 299) return 'b';
  if (c >= 300 && c <= 309) return 's';
  if (c >= 310 && c <= 319) return 'x';
  if (c >= 320 && c <= 369) return 's';
  if (c >= 370 && c <= 389) return 'i';
  if (c >= 390 && c <= 399) return 's';
  if (c >= 400 && c <= 409) return 'i';
  if (c >= 410 && c <= 419) return 's';
  if (c >= 420 && c <= 429) return 'l';
  if (c >= 430 && c <= 439) return 's';
  if (c >= 440 && c <= 449) return 'l';
  if (c >= 450 && c <= 459) return 'q';
  if (c >= 460 && c <= 469) return 'd';
  if (c >= 470 && c <= 481) return 's';
  if (c === 999) return 's';
  if (c === 1004) return 'x';
  if (c >= 1000 && c <= 1009) return 's';
  if (c >= 1010 && c <= 1059) return 'd';
  if (c >= 1060 && c <= 1070) return 'i';
  if (c === 1071) return 'l';
  return 's';
}

function isBinaryDxf(bytes) {
  if (bytes.length < 22) return false;
  for (let i = 0; i < 22; i++) if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

/** What the first bytes say about the file. */
function sniff(bytes) {
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (/^AC10\d\d/.test(head) || /^AC1\.[0-9]/.test(head) || /^MC0\.0/.test(head)) return { kind: 'dwg', version: head.slice(0, 6) };
  if (isBinaryDxf(bytes)) return { kind: 'binary' };
  return { kind: 'ascii' };
}

function decodeText(sub) {
  try { return utf8.decode(sub); } catch { return latin1.decode(sub); }
}

class DxfError extends Error {
  constructor(message, offset) { super(message); this.offset = offset; }
}

/** ASCII DXF: pairs of lines. Works on bytes, so files close to the V8 string limit still open. */
class AsciiReader {
  constructor(bytes) {
    this.kind = 'ascii'; this.b = bytes; this.pos = 0; this.line = 0; this.code = -1; this.value = null; this.peeked = false;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) this.pos = 3;
  }
  _line() {
    const b = this.b, n = b.length;
    if (this.pos >= n) return null;
    let s = this.pos, e = s;
    while (e < n && b[e] !== 10) e++;
    this.pos = e + 1; this.line++;
    let end = e;
    if (end > s && b[end - 1] === 13) end--;
    return [s, end];
  }
  /** Returns true when a pair was read; this.code and this.value hold it. */
  next() {
    if (this.peeked) { this.peeked = false; return this.code !== -1; }
    const lc = this._line();
    if (!lc) { this.code = -1; return false; }
    const b = this.b;
    let s = lc[0], e = lc[1];
    while (s < e && (b[s] === 32 || b[s] === 9)) s++;
    while (e > s && (b[e - 1] === 32 || b[e - 1] === 9)) e--;
    let code = 0, neg = false, any = false;
    if (b[s] === 45) { neg = true; s++; }
    for (let i = s; i < e; i++) {
      const d = b[i] - 48;
      if (d < 0 || d > 9) throw new DxfError(`Line ${this.line} should hold a group code (a number) but holds "${latin1.decode(this.b.subarray(lc[0], Math.min(lc[1], lc[0] + 40)))}".`, lc[0]);
      code = code * 10 + d; any = true;
    }
    if (!any) {
      if (this.pos >= b.length) { this.code = -1; return false; } // trailing blank line
      throw new DxfError(`Line ${this.line} should hold a group code but is empty.`, lc[0]);
    }
    if (neg) code = -code;
    const vl = this._line();
    if (!vl) throw new DxfError(`The file ends after group code ${code} on line ${this.line} without its value.`, b.length);
    const kind = codeKind(code);
    let v;
    if (kind === 's' || kind === 'x') {
      v = decodeText(b.subarray(vl[0], vl[1]));
    } else {
      const t = latin1.decode(b.subarray(vl[0], vl[1])).trim();
      v = kind === 'd' ? parseFloat(t) : parseInt(t, 10);
      if (Number.isNaN(v)) v = kind === 'd' ? 0 : 0;
    }
    this.code = code; this.value = v;
    return true;
  }
  /** Push the current pair back, so the next next() returns it again. */
  back() { this.peeked = true; }
  get offset() { return this.pos; }
}

/** Binary DXF (R13 and later use 2-byte group codes, R12 uses 1 byte with 255 as an escape). */
class BinaryReader {
  constructor(bytes) {
    this.kind = 'binary'; this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 22; this.code = -1; this.value = null; this.peeked = false;
    // R12: the first code is 1 byte (0) followed by "SECTION". R13+: 2 bytes (0, 0).
    this.short = !(bytes[22] === 0 && bytes[23] === 0x53);
  }
  _need(n) {
    if (this.pos + n > this.b.length) throw new DxfError(`The binary DXF data is cut off at byte ${this.pos}.`, this.pos);
  }
  _str() {
    const b = this.b; let e = this.pos;
    while (e < b.length && b[e] !== 0) e++;
    if (e >= b.length) throw new DxfError(`A text value at byte ${this.pos} has no end.`, this.pos);
    const s = decodeText(b.subarray(this.pos, e)); this.pos = e + 1; return s;
  }
  next() {
    if (this.peeked) { this.peeked = false; return this.code !== -1; }
    if (this.pos >= this.b.length) { this.code = -1; return false; }
    let code;
    if (this.short) { this._need(2); code = this.dv.getInt16(this.pos, true); this.pos += 2; }
    else { this._need(1); code = this.b[this.pos++]; if (code === 255) { this._need(2); code = this.dv.getInt16(this.pos, true); this.pos += 2; } }
    const kind = codeKind(code);
    let v;
    switch (kind) {
      case 'd': this._need(8); v = this.dv.getFloat64(this.pos, true); this.pos += 8; break;
      case 'i': this._need(2); v = this.dv.getInt16(this.pos, true); this.pos += 2; break;
      case 'l': this._need(4); v = this.dv.getInt32(this.pos, true); this.pos += 4; break;
      case 'q': this._need(8); v = Number(this.dv.getBigInt64(this.pos, true)); this.pos += 8; break;
      case 'b': this._need(1); v = this.b[this.pos++]; break;
      case 'x': { this._need(1); const n = this.b[this.pos++]; this._need(n); v = ''; for (let i = 0; i < n; i++) v += this.b[this.pos + i].toString(16).padStart(2, '0'); this.pos += n; break; }
      default: v = this._str();
    }
    this.code = code; this.value = v;
    return true;
  }
  back() { this.peeked = true; }
  get offset() { return this.pos; }
}

function createReader(bytes) {
  return isBinaryDxf(bytes) ? new BinaryReader(bytes) : new AsciiReader(bytes);
}

module.exports = { createReader, AsciiReader, BinaryReader, codeKind, sniff, isBinaryDxf, DxfError, BINARY_SENTINEL };
