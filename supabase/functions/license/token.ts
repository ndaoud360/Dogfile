// Signed tokens: what the server hands the app (trial or licence), bound to one PC. Compact enough to type in for
// offline activation. Layout (24 bytes, then a 64-byte Ed25519 signature over them):
//   [0] version 1   [1] kind (1 trial, 2 licence)   [2..12] the PC's ID (10 bytes)
//   [12..16] issued (unix seconds)   [16..20] a: trial end (unix s) | licence number   [20..24] b: trial start | activation number
// Written in Crockford base32 (0-9 A-Z without I L O U), grouped by 5 for reading. The app (backend/src/license.rs)
// checks the signature with the public key compiled into it; only this server holds the private key.

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KIND_TRIAL = 1, KIND_LICENSE = 2;

export function b32encode(bytes: Uint8Array): string {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Uint8Array<ArrayBuffer> | null {
  const clean = s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of clean) {
    const v = ALPHA.indexOf(c);
    if (v < 0) return null;
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    val &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}
export const group = (s: string, n = 5) => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join('-');

/** a PC's ID as the app sends it: 16 base32 characters (10 bytes) */
export function parseMachine(m: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof m !== 'string') return null;
  const b = b32decode(m);
  return b && b.length === 10 && m.replace(/[\s-]/g, '').length === 16 ? b : null;
}
export const machineText = (b: Uint8Array) => b32encode(b);

export interface Claims { kind: number; machine: Uint8Array; issued: number; a: number; b: number }
export function payload(c: Claims): Uint8Array<ArrayBuffer> {
  const p = new Uint8Array(24); const dv = new DataView(p.buffer);
  p[0] = 1; p[1] = c.kind; p.set(c.machine, 2);
  dv.setUint32(12, c.issued >>> 0); dv.setUint32(16, c.a >>> 0); dv.setUint32(20, c.b >>> 0);
  return p;
}
export async function sign(key: CryptoKey, c: Claims): Promise<string> {
  const p = payload(c);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, p));
  const t = new Uint8Array(88); t.set(p); t.set(sig, 24);
  return b32encode(t);
}
export async function verify(pub: CryptoKey, token: string): Promise<Claims | null> {
  const t = b32decode(token);
  if (!t || t.length !== 88 || t[0] !== 1) return null;
  const ok = await crypto.subtle.verify('Ed25519', pub, t.slice(24), t.slice(0, 24));
  if (!ok) return null;
  const dv = new DataView(t.buffer, t.byteOffset);
  return { kind: t[1], machine: t.slice(2, 12), issued: dv.getUint32(12), a: dv.getUint32(16), b: dv.getUint32(20) };
}

// serial numbers: DOGF-XXXXX-XXXXX-XXXXX-XXXXX (100 random bits)
export function newSerial(): string {
  const r = crypto.getRandomValues(new Uint8Array(13));
  return 'DOGF-' + group(b32encode(r).slice(0, 20));
}
export function normalizeSerial(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const c = s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/^D0GF/, 'DOGF');
  const body = c.startsWith('DOGF') ? c.slice(4) : c;
  if (body.length !== 20 || [...body].some((ch) => !ALPHA.includes(ch))) return null;
  return 'DOGF-' + group(body);
}

// the signing key pair (raw public key, PKCS#8 private key), base64
export async function newKeyPair(): Promise<{ pub: string; priv: string }> {
  const k = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey));
  return { pub: b64(pub), priv: b64(priv) };
}
export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const importPriv = (s: string) => crypto.subtle.importKey('pkcs8', unb64(s), 'Ed25519', false, ['sign']);
export const importPub = (s: string) => crypto.subtle.importKey('raw', unb64(s), 'Ed25519', false, ['verify']);
