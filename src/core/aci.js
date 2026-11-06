'use strict';
// AutoCAD Color Index (ACI) to RGB. 1-9 and 250-255 are fixed; 10-249 follow the hue/shade pattern of the ACI wheel.

const FIXED = {
  1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080, 9: 0xc0c0c0,
  250: 0x333333, 251: 0x505050, 252: 0x696969, 253: 0x828282, 254: 0xbebebe, 255: 0xffffff,
};
const VALUE = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15];

function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255);
}

const TABLE = new Array(256).fill(0xffffff);
for (let i = 1; i < 256; i++) {
  if (FIXED[i] !== undefined) TABLE[i] = FIXED[i];
  else if (i >= 10 && i <= 249) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = i % 10;
    TABLE[i] = hsv(hue, k % 2 === 0 ? 1 : 0.5, VALUE[k]);
  }
}

function aciToRgb(i) { return TABLE[Math.abs(i) | 0] ?? 0xffffff; }

module.exports = { aciToRgb, ACI: TABLE };
