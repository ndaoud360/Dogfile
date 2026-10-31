import { api, h } from './core.js';

// minimal EXIF reader for JPEGs (camera, lens, exposure, ISO, date, GPS)
export async function readExif(p) {
  const b = new Uint8Array(await api('fs:readBytes', p, 196608));
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o < b.length - 4) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.slice(o + 4, o + 8)) === 'Exif') return parseTiff(b, o + 10);
    o += 2 + len;
  }
  return null;
}
function parseTiff(b, t) {
  const le = b[t] === 0x49;
  const u16 = (i) => (le ? b[t + i] | (b[t + i + 1] << 8) : (b[t + i] << 8) | b[t + i + 1]);
  const u32 = (i) => (le ? (b[t + i] | (b[t + i + 1] << 8) | (b[t + i + 2] << 16) | (b[t + i + 3] << 24)) >>> 0 : ((b[t + i] << 24) | (b[t + i + 1] << 16) | (b[t + i + 2] << 8) | b[t + i + 3]) >>> 0);
  const readIfd = (off, into) => {
    if (!off || t + off + 2 > b.length) return;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12; if (t + e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const vo = (sizes[type] || 1) * count > 4 ? u32(e + 8) : e + 8;
      let val;
      if (type === 2) val = String.fromCharCode(...b.slice(t + vo, t + vo + count)).replace(/\0+$/, '').trim();
      else if (type === 3) val = u16(vo);
      else if (type === 4) val = u32(vo);
      else if (type === 5 || type === 10) { val = []; for (let q = 0; q < count; q++) { const nu = u32(vo + q * 8), de = u32(vo + q * 8 + 4); val.push(de ? nu / de : 0); } if (count === 1) val = val[0]; }
      into[tag] = val;
    }
  };
  const tags = {}, exif = {}, gps = {};
  readIfd(u32(4), tags);
  if (tags[0x8769]) readIfd(tags[0x8769], exif);
  if (tags[0x8825]) readIfd(tags[0x8825], gps);
  const rows = [];
  const make = tags[0x010f] || '', model = tags[0x0110] || '';
  const cam = model.startsWith(make) ? model : [make, model].filter(Boolean).join(' ');
  if (cam) rows.push(['Camera', cam]);
  if (exif[0xa434]) rows.push(['Lens', exif[0xa434]]);
  const exp = [];
  if (exif[0x829d]) exp.push(`f/${(+exif[0x829d]).toFixed(1)}`);
  if (exif[0x829a]) exp.push(exif[0x829a] < 1 ? `1/${Math.round(1 / exif[0x829a])} s` : `${exif[0x829a]} s`);
  if (exif[0x8827]) exp.push(`ISO ${exif[0x8827]}`);
  if (exif[0x920a]) exp.push(`${Math.round(exif[0x920a])} mm`);
  if (exp.length) rows.push(['Exposure', exp.join(' · ')]);
  const taken = exif[0x9003] || tags[0x0132];
  if (taken) rows.push(['Taken', String(taken).replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')]);
  if (Array.isArray(gps[2]) && Array.isArray(gps[4])) {
    const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
    const lat = dms(gps[2]) * (gps[1] === 'S' ? -1 : 1), lon = dms(gps[4]) * (gps[3] === 'W' ? -1 : 1);
    rows.push(['Location', h('button', { class: 'link', onclick: () => api('shell:openExternal', `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`) }, `${lat.toFixed(5)}, ${lon.toFixed(5)}`)]);
  }
  return rows.length ? rows : null;
}

