// Tests the licence server against a real Postgres (Stripe and email faked):
//   DB_URL=postgres://postgres@127.0.0.1:54329/lic deno test -A supabase/functions/license/test.ts
import postgres from 'npm:postgres@3.4.5';
import * as core from './core.ts';
import { b32decode, b32encode, importPub, normalizeSerial, verify, KIND_LICENSE, KIND_TRIAL } from './token.ts';

const sql = postgres(Deno.env.get('DB_URL')!, { prepare: false, max: 2, onnotice: () => {} });
const emails: { to: string; text: string }[] = [];
const sessions: Record<string, any> = {};
const env: Record<string, string> = { ADMIN_SECRET: 'admin-secret-123456', STRIPE_SECRET_KEY: 'sk_test_x' };
let managed = false; // pretend the Stripe account uses Managed Payments
let lastForm: Record<string, string> = {};
const d: core.Deps = {
  sql, env: (k) => env[k], now: () => Date.now(), self: 'https://example.supabase.co/functions/v1/license',
  email: async (to, _s, _h, text) => { emails.push({ to, text }); return true; },
  stripe: async (method, path, form) => {
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      lastForm = { ...form! };
      if (managed && Object.keys(form!).some((k) => k.startsWith('invoice_creation'))) return { error: { message: 'invoice_creation[invoice_data] is not supported when Managed Payments is enabled.' } };
      const id = 'cs_test_' + crypto.randomUUID().replace(/-/g, '');
      sessions[id] = { id, url: 'https://checkout.stripe.com/c/pay/' + id, payment_status: 'unpaid', metadata: { product: 'dogfile-pro', machine: form!['metadata[machine]'], serial: form!['metadata[serial]'] }, invoice_serial: form!['invoice_creation[invoice_data][custom_fields][0][value]'], amount_total: 1999, currency: 'usd', payment_intent: 'pi_' + id.slice(8, 20), customer_details: { email: 'buyer@example.com' } };
      return sessions[id];
    }
    if (method === 'GET' && path.startsWith('/v1/checkout/sessions/')) return sessions[path.split('/').pop()!] || { error: 'no such session' };
    if (method === 'POST' && path === '/v1/webhook_endpoints') return { id: 'we_1', secret: 'whsec_test' };
    throw new Error('unexpected stripe call ' + path);
  },
};
const mid = (n: number) => b32encode(new Uint8Array(10).fill(n)); // a PC ID
const eq = (a: unknown, b: unknown, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const throwsCode = async (p: Promise<unknown>, code: string) => { try { await p; } catch (e) { eq((e as core.HttpError).code, code, 'error code'); return e as core.HttpError; } throw new Error('expected error ' + code); };
const stripeSig = async (raw: string, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};

Deno.test('licence server', async (t) => {
  await sql`truncate dogfile.licenses, dogfile.activations, dogfile.deactivations, dogfile.trials, dogfile.attempts, dogfile.config restart identity cascade`;
  core.resetKeyCache();
  let pub: CryptoKey;

  await t.step('signing key: made once', async () => {
    const a = (await core.keys(d)).pubText; core.resetKeyCache();
    const b = (await core.keys(d)).pubText;
    eq(a, b, 'same key after reload'); eq(atob(a).length, 32, 'raw public key');
    pub = await importPub(a);
  });

  await t.step('trial: one per PC, start fixed', async () => {
    await throwsCode(core.trial(d, { machine: 'nope' }, 'ip1'), 'bad_request');
    const r1 = await core.trial(d, { machine: mid(1), version: '2.2.0' }, 'ip1');
    eq(r1.end - r1.start, 14 * 86400, 'fourteen days');
    const c = await verify(pub, r1.token);
    ok(c && c.kind === KIND_TRIAL && b32encode(c.machine) === mid(1) && c.a === r1.end && c.b === r1.start, 'trial token checks out');
    // reinstalling / asking again later gives the same start
    await sql`update dogfile.trials set started_at = now() - interval '20 days' where machine = ${mid(1)}`;
    const r2 = await core.trial(d, { machine: mid(1) }, 'ip1');
    ok(r2.end < r2.now, 'an old trial stays expired');
    eq(r2.token.length, 141, 'token length');
  });

  let serial = '';
  await t.step('activation: 2 PCs, the same PC again is free, a third is refused', async () => {
    await throwsCode(core.admin(d, 'issue', {}, 'wrong'), 'unauthorized');
    serial = (await core.admin(d, 'issue', { email: 'gift@example.com', note: 'test' }, env.ADMIN_SECRET)).serial;
    ok(/^DOGF(-[0-9A-HJKMNP-TV-Z]{5}){4}$/.test(serial), 'serial format ' + serial);
    eq(emails.at(-1)?.to, 'gift@example.com', 'serial emailed');
    const a1 = await core.activate(d, { serial: serial.toLowerCase().replace(/-/g, ' '), machine: mid(10), name: 'Desk' }, 'ip2');
    const c = await verify(pub, a1.token);
    ok(c && c.kind === KIND_LICENSE && b32encode(c.machine) === mid(10), 'licence token for this PC');
    const again = await core.activate(d, { serial, machine: mid(10) }, 'ip2');
    eq((await verify(pub, again.token))!.b, c!.b, 'same activation reused');
    await core.activate(d, { serial, machine: mid(11), name: 'Laptop' }, 'ip2');
    const e = await throwsCode(core.activate(d, { serial, machine: mid(12) }, 'ip2'), 'too_many_machines');
    ok(e.message.includes('Desk') && e.message.includes('Laptop'), 'names the PCs it is on');
    // move it: deactivate one, then the third PC works
    await core.deactivate(d, { token: a1.token });
    eq((await core.validate(d, { token: a1.token })).reason, 'deactivated', 'old PC sees it was deactivated');
    await core.activate(d, { serial, machine: mid(12) }, 'ip2');
    eq((await core.admin(d, 'lookup', { serial }, env.ADMIN_SECRET)).activations.length, 2, 'two PCs');
  });

  await t.step('tokens can’t be forged or moved', async () => {
    const a = await core.activate(d, { serial, machine: mid(12) }, 'ip2');
    const bytes = b32decode(a.token)!; bytes[5] ^= 1; // another PC ID
    eq(await verify(pub, b32encode(bytes)), null, 'edited token rejected');
    await throwsCode(core.validate(d, { token: b32encode(bytes) }), 'bad_token');
    const other = await importPub((await crypto.subtle.exportKey('raw', ((await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair).publicKey) as ArrayBuffer).byteLength ? btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', ((await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair).publicKey)))) : '');
    eq(await verify(other, a.token), null, 'another key rejects it');
  });

  await t.step('wrong serial numbers are rate limited', async () => {
    for (let i = 0; i < 10; i++) await throwsCode(core.activate(d, { serial: 'DOGF-AAAAA-AAAAA-AAAAA-AAAA' + (i % 10), machine: mid(20) }, 'ip3'), 'unknown_serial');
    await throwsCode(core.activate(d, { serial, machine: mid(20) }, 'ip3'), 'rate_limited');
    await throwsCode(core.activate(d, { serial: 'hello', machine: mid(21) }, 'ip4'), 'bad_serial');
  });

  await t.step('offline activation answers in text', async () => {
    const s2 = (await core.admin(d, 'issue', { send: false }, env.ADMIN_SECRET)).serial;
    const r = await core.offline(d, new URLSearchParams({ k: s2, m: mid(30) }), 'ip5');
    eq(r.status, 200, 'status');
    const code = r.text.split('\n')[2];
    ok(/^([0-9A-Z]{5}-){28}[0-9A-Z]$/.test(code), 'grouped code ' + code);
    const c = await verify(pub, code);
    ok(c && b32encode(c.machine) === mid(30), 'code for that PC');
    const f = await core.offline(d, new URLSearchParams({ k: s2, m: mid(30), download: '1' }), 'ip5');
    ok(f.file && f.text.trim() === code, 'as a file');
    const bad = await core.offline(d, new URLSearchParams({ k: 'DOGF-11111-11111-11111-11111', m: mid(31) }), 'ip6');
    ok(bad.status === 400 && bad.text.includes('wasn’t found'), 'explains failures');
  });

  await t.step('buying: checkout, webhook, claim, email once, refund revokes', async () => {
    const co = await core.checkout(d, { machine: mid(40) });
    ok(co.url.startsWith('https://checkout.stripe.com/'), 'payment page');
    eq((await core.claim(d, new URLSearchParams({ session: co.session }))).pending, true, 'not paid yet');
    const onInvoice = sessions[co.session].invoice_serial;
    ok(/^DOGF-/.test(onInvoice) && onInvoice === sessions[co.session].metadata.serial, 'the invoice carries the serial');
    await throwsCode(core.activate(d, { serial: onInvoice, machine: mid(40) }, 'ip8'), 'unknown_serial');
    ok((await core.thanks(d, new URLSearchParams({ session_id: co.session }))).includes('being confirmed'), 'thanks before paid');
    sessions[co.session].payment_status = 'paid';
    await core.admin(d, 'setup', {}, env.ADMIN_SECRET);
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: sessions[co.session] } });
    await throwsCode(core.webhook(d, raw, 't=1,v1=00'), 'bad_signature');
    await throwsCode(core.webhook(d, raw, await stripeSig(raw, 'whsec_wrong')), 'bad_signature');
    const n0 = emails.length;
    await core.webhook(d, raw, await stripeSig(raw));
    await core.webhook(d, raw, await stripeSig(raw)); // Stripe retries
    eq(emails.length, n0 + 1, 'one email');
    eq(emails.at(-1)?.to, 'buyer@example.com', 'to the buyer');
    const cl = await core.claim(d, new URLSearchParams({ session: co.session }));
    ok(cl.serial && emails.at(-1)!.text.includes(cl.serial), 'the app gets the emailed serial');
    eq(cl.serial, onInvoice, 'the same serial as on the Stripe invoice');
    ok((await core.thanks(d, new URLSearchParams({ session_id: co.session }))).includes(cl.serial!), 'thank-you page shows it');
    const a = await core.activate(d, { serial: cl.serial, machine: mid(40) }, 'ip7');
    eq((await core.validate(d, { token: a.token })).ok, true, 'valid');
    const refund = JSON.stringify({ type: 'charge.refunded', data: { object: { payment_intent: sessions[co.session].payment_intent, refunded: true } } });
    await core.webhook(d, refund, await stripeSig(refund));
    eq((await core.validate(d, { token: a.token })).reason, 'revoked', 'refund cancels it');
    await throwsCode(core.activate(d, { serial: cl.serial, machine: mid(41) }, 'ip7'), 'revoked');
  });

  await t.step('paid but the webhook is late: the app claims it straight from Stripe', async () => {
    const co = await core.checkout(d, {});
    sessions[co.session].payment_status = 'paid';
    const cl = await core.claim(d, new URLSearchParams({ session: co.session }));
    ok(cl.serial, 'serial from claim');
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: sessions[co.session] } });
    const n0 = emails.length;
    await core.webhook(d, raw, await stripeSig(raw));
    eq(emails.length, n0, 'no second licence or email');
    eq((await sql`select count(*)::int as n from dogfile.licenses where stripe_session = ${co.session}`)[0].n, 1, 'one licence');
  });

  await t.step('Managed Payments accounts: no invoice options, the serial goes in the description', async () => {
    managed = true;
    const co = await core.checkout(d, { machine: mid(50) });
    ok(co.url && co.session, 'payment page opened after the retry');
    eq(lastForm['line_items[0][price_data][product_data][tax_code]'], 'txcd_10202000', 'tax code sent');
    ok(String(lastForm['line_items[0][price_data][product_data][description]']).includes(sessions[co.session].metadata.serial), 'serial in the description');
    managed = false;
  });

  await t.step('moving between PCs is limited', async () => {
    const s = (await core.admin(d, 'issue', { send: false }, env.ADMIN_SECRET)).serial;
    for (let i = 0; i < 5; i++) { const a = await core.activate(d, { serial: s, machine: mid(50 + i) }, 'ip8'); await core.deactivate(d, { token: a.token }); }
    const a = await core.activate(d, { serial: s, machine: mid(60) }, 'ip8');
    await throwsCode(core.deactivate(d, { token: a.token }), 'rate_limited');
  });

  await t.step('serial typing mistakes are forgiven', () => {
    eq(normalizeSerial('dogf-abcde-fghjk-mnpqr-stvwx'), 'DOGF-ABCDE-FGHJK-MNPQR-STVWX', 'lowercase');
    eq(normalizeSerial('DOGF ABCDE FGHJK MNPQR STVWO'), 'DOGF-ABCDE-FGHJK-MNPQR-STVW0', 'O for 0');
    eq(normalizeSerial('ABCDEFGHJKMNPQRSTVWX'), 'DOGF-ABCDE-FGHJK-MNPQR-STVWX', 'no prefix');
    eq(normalizeSerial('DOGF-ABCDE'), null, 'too short');
  });

  // a token for the Rust test (backend/src/license.rs reads these)
  const tr = await core.trial(d, { machine: mid(7) }, 'ip9');
  await Deno.writeTextFile(Deno.env.get('TOKENS_OUT') || '/dev/null', JSON.stringify({ pubkey: (await core.keys(d)).pubText, machine: mid(7), trial: tr, license: await core.activate(d, { serial: (await core.admin(d, 'issue', { send: false }, env.ADMIN_SECRET)).serial, machine: mid(7) }, 'ip9') }));
  await sql.end();
});
