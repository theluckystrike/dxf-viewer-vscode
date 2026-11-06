'use strict';
// Turns DXF text codes into plain text. The result is drawn with fillText (never parsed as HTML).

const SPECIAL = { c: '⌀', d: '°', p: '±', '%': '%' };

function unicodeEscapes(s) {
  return s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+[0-9a-fA-F]([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** TEXT, ATTRIB: %%c %%d %%p, %%nnn, underline/overline toggles. */
function cleanText(s) {
  s = unicodeEscapes(String(s));
  s = s.replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/%%([cdpCDP%])/g, (_, k) => SPECIAL[k.toLowerCase()]);
  s = s.replace(/%%[uoUOkK]/g, '');
  return s.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
}

/** MTEXT: strips inline formatting ({\fArial|b1;...}, \H2.5x;, \C1; ...) and keeps paragraphs. */
function cleanMText(s) {
  s = unicodeEscapes(String(s));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') { out += ch; continue; }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === 'P' || n === 'n') { out += '\n'; i++; continue; }
    if (n === '~') { out += ' '; i++; continue; }
    if (n === '\\' || n === '{' || n === '}') { out += n; i++; continue; }
    if ('LlOoKkNX'.includes(n)) { i++; continue; }
    if (n === 'S') { // stacked fraction: \S1/2;  ->  1/2
      const end = s.indexOf(';', i + 2);
      const body = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
      out += body.replace(/[#^]/, '/');
      i = end < 0 ? s.length : end; continue;
    }
    if ('fFHhCcTtQqWwAap'.includes(n)) { const end = s.indexOf(';', i + 2); i = end < 0 ? s.length : end; continue; }
    out += n; i++;
  }
  return cleanText(out.replace(/[ \t]+\n/g, '\n'));
}

module.exports = { cleanText, cleanMText };
