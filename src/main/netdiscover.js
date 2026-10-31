// Finds devices on the local network the way File Explorer's Network page does for media devices:
// SSDP / UPnP (TVs, speakers, media servers, routers, printers, NAS boxes). Computers come from the
// Windows shell's Network folder (WS-Discovery / NetBIOS), merged in winshell.discoverNetwork.
'use strict';
const dgram = require('dgram');
const http = require('http');

function fetchXml(url, timeout = 2000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 256 * 1024) req.destroy(); });
        res.on('end', () => resolve(body));
      });
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; };
function kindOf(deviceType, server = '') {
  const t = (deviceType + ' ' + server).toLowerCase();
  if (/mediarenderer|dial|tv|roku|chromecast/.test(t)) return 'Media devices';
  if (/mediaserver|dlna|plex|nas/.test(t)) return 'Media servers';
  if (/internetgateway|wanconnection|router/.test(t)) return 'Network infrastructure';
  if (/print/.test(t)) return 'Printers';
  if (/zoneplayer|sonos|speaker/.test(t)) return 'Media devices';
  return 'Other devices';
}

function ssdpDiscover(timeout = 2600) {
  return new Promise((resolve) => {
    const found = new Map(); // location -> {ip, server, st}
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    const done = async () => {
      try { sock.close(); } catch {}
      const out = [];
      await Promise.all([...found.entries()].slice(0, 40).map(async ([loc, info]) => {
        const xml = await fetchXml(loc);
        const name = tag(xml, 'friendlyName') || info.server || info.ip;
        const deviceType = tag(xml, 'deviceType');
        let pres = tag(xml, 'presentationURL');
        if (pres && !/^https?:/i.test(pres)) { try { pres = new URL(pres, loc).href; } catch { pres = ''; } }
        if (!/^https?:\/\//i.test(pres)) pres = ''; // only plain web pages, never other URL schemes
        out.push({ name, type: kindOf(deviceType, info.server), model: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' '), ip: info.ip, url: pres || '', source: 'ssdp' });
      }));
      // one entry per device name + ip
      const seen = new Set();
      resolve(out.filter((d) => { const k = d.name + '|' + d.ip; if (seen.has(k)) return false; seen.add(k); return true; }));
    };
    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      const loc = (s.match(/^location:\s*(.+)$/im) || [])[1];
      if (!loc) return;
      const url = loc.trim();
      if (!found.has(url)) found.set(url, { ip: rinfo.address, server: ((s.match(/^server:\s*(.+)$/im) || [])[1] || '').trim(), st: ((s.match(/^st:\s*(.+)$/im) || [])[1] || '').trim() });
    });
    sock.on('error', () => done());
    sock.bind(0, () => {
      const q = (st) => Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
      for (const st of ['ssdp:all', 'upnp:rootdevice', 'urn:dial-multiscreen-org:service:dial:1']) {
        try { sock.send(q(st), 1900, '239.255.255.250'); } catch {}
      }
      setTimeout(() => { try { sock.send(q('ssdp:all'), 1900, '239.255.255.250'); } catch {} }, 700);
      setTimeout(done, timeout);
    });
  });
}

module.exports = { ssdpDiscover };
