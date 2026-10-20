// Fast picture metadata from file headers (no decoding): width/height, date taken, camera, orientation.
// Used by gallery mode for justified rows, "date taken" / "camera" / "dimensions" sorting and auto grouping.
'use strict';
const fs = require('fs');

function readHead(p, n = 131072) {
  let fd;
  try { fd = fs.openSync(p, 'r'); const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, r); } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

function tiff(b, t, out) {
  if (t + 8 > b.length) return;
  const le = b[t] === 0x49;
  const u16 = (i) => (t + i + 2 <= b.length ? (le ? b.readUInt16LE(t + i) : b.readUInt16BE(t + i)) : 0);
  const u32 = (i) => (t + i + 4 <= b.length ? (le ? b.readUInt32LE(t + i) : b.readUInt32BE(t + i)) : 0);
  const ifd = (off, want) => {
    const res = {};
    if (!off || t + off + 2 > b.length) return res;
    const n = Math.min(u16(off), 400);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (t + e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (!want.includes(tag)) continue;
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 7: 1, 9: 4 }[type] || 1) * count;
      const vo = size > 4 ? u32(e + 8) : e + 8;
      if (type === 2) res[tag] = b.toString('latin1', t + vo, Math.min(b.length, t + vo + count)).replace(/\0+$/, '').trim();
      else if (type === 3) res[tag] = u16(vo);
      else if (type === 4) res[tag] = u32(vo);
    }
    return res;
  };
  const i0 = ifd(u32(4), [0x010f, 0x0110, 0x0112, 0x0132, 0x8769, 0x0131]);
  const ex = i0[0x8769] ? ifd(i0[0x8769], [0x9003, 0x9004, 0xa002, 0xa003]) : {};
  const make = i0[0x010f] || '', model = i0[0x0110] || '';
  if (make || model) out.camera = model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : [make, model].filter(Boolean).join(' ');
  if (i0[0x0112]) out.orient = i0[0x0112];
  if (i0[0x0131]) out.software = i0[0x0131];
  const d = ex[0x9003] || ex[0x9004] || i0[0x0132];
  if (d && /^\d{4}:\d\d:\d\d \d\d:\d\d/.test(d)) { const [y, mo, da, hh, mi, ss] = d.match(/\d+/g).map(Number); const ms = new Date(y, mo - 1, da, hh, mi, ss || 0).getTime(); if (ms > 0) out.taken = ms; }
  if (!out.w && ex[0xa002]) { out.w = ex[0xa002]; out.h = ex[0xa003]; }
}

function parse(b) {
  const out = {};
  if (!b || b.length < 24) return out;
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = b.readUInt16BE(o + 2);
      if (m === 0xe1 && b.toString('latin1', o + 4, o + 8) === 'Exif') tiff(b, o + 10, out);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { out.h = b.readUInt16BE(o + 5); out.w = b.readUInt16BE(o + 7); break; }
      if (m === 0xda) break;
      o += 2 + len;
    }
  } else if (b.readUInt32BE(0) === 0x89504e47) { out.w = b.readUInt32BE(16); out.h = b.readUInt32BE(20); // PNG
    const i = b.indexOf('eXIf'); if (i > 0) tiff(b, i + 4, out);
    if (b.indexOf('Adobe') > 0 && b.indexOf('Adobe') < 4096) out.software = 'Adobe';
  } else if (b.toString('latin1', 0, 3) === 'GIF') { out.w = b.readUInt16LE(6); out.h = b.readUInt16LE(8); }
  else if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const k = b.toString('latin1', 12, 16);
    if (k === 'VP8 ') { out.w = b.readUInt16LE(26) & 0x3fff; out.h = b.readUInt16LE(28) & 0x3fff; }
    else if (k === 'VP8L') { const v = b.readUInt32LE(21); out.w = (v & 0x3fff) + 1; out.h = ((v >> 14) & 0x3fff) + 1; }
    else if (k === 'VP8X') { out.w = 1 + b.readUIntLE(24, 3); out.h = 1 + b.readUIntLE(27, 3); const i = b.indexOf('EXIF'); if (i > 0) tiff(b, i + 8 + (b.toString('latin1', i + 8, i + 12) === 'Exif' ? 6 : 0), out); }
  } else if (b.toString('latin1', 0, 2) === 'BM') { out.w = b.readInt32LE(18); out.h = Math.abs(b.readInt32LE(22)); }
  else if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) tiff(b, 0, out); // TIFF / many RAW files
  else if (b.toString('latin1', 4, 8) === 'ftyp') { // HEIC/AVIF: 'ispe' box has the size; Exif lives elsewhere
    const i = b.indexOf('ispe'); if (i > 0) { out.w = b.readUInt32BE(i + 8); out.h = b.readUInt32BE(i + 12); }
    const e = b.indexOf('Exif\0\0'); if (e > 0) tiff(b, e + 6, out);
  }
  if (out.orient >= 5 && out.orient <= 8 && out.w) [out.w, out.h] = [out.h, out.w];
  return out;
}

function meta(paths) {
  return paths.map((p) => { try { return parse(readHead(p)); } catch { return {}; } });
}
module.exports = { meta, parse };
