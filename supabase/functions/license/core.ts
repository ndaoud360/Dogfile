// Dogfile's licence server: trials, activation (online and offline), deactivation, revalidation, Stripe checkout and
// fulfilment, refunds, and a few admin routes. index.ts wires it to Supabase; test.ts runs it against a local database.
import {
  KIND_LICENSE, KIND_TRIAL, group, importPriv, importPub, machineText, newKeyPair, newSerial, normalizeSerial, parseMachine, sign, verify,
} from './token.ts';

export const TRIAL_DAYS = 14;
export const PRICE_CENTS = 1999;
const DEACTIVATIONS_PER_30_DAYS = 5;

// deno-lint-ignore no-explicit-any
type Sql = any;
export interface Deps {
  sql: Sql;
  env: (k: string) => string | undefined;
  /** Stripe REST: method, path (/v1/...), form fields */
  stripe: (method: string, path: string, form?: Record<string, string>) => Promise<any>;
  email: (to: string, subject: string, html: string, text: string) => Promise<boolean>;
  now: () => number; // ms
  self: string; // this function's public URL, without a trailing slash
}

export class HttpError extends Error { constructor(public status: number, message: string, public code = 'error') { super(message); } }
const bad = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);
const secs = (ms: number) => Math.floor(ms / 1000);

// ---------- keys ----------
let keyCache: { priv: CryptoKey; pub: CryptoKey; pubText: string } | null = null;
export async function keys(d: Deps) {
  if (keyCache) return keyCache;
  let rows = await d.sql`select key, value from dogfile.config where key in ('sign_priv', 'sign_pub')`;
  if (rows.length < 2) {
    const k = await newKeyPair();
    // two requests at once: the first insert wins, both read it back
    await d.sql`insert into dogfile.config (key, value) values ('sign_priv', ${k.priv}), ('sign_pub', ${k.pub}) on conflict (key) do nothing`;
    rows = await d.sql`select key, value from dogfile.config where key in ('sign_priv', 'sign_pub')`;
  }
  const m = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  keyCache = { priv: await importPriv(m.sign_priv), pub: await importPub(m.sign_pub), pubText: m.sign_pub };
  return keyCache;
}
export const resetKeyCache = () => { keyCache = null; };

// ---------- rate limits ----------
async function limit(d: Deps, kind: string, who: string, max: number, minutes: number, msg: string) {
  const [{ n }] = await d.sql`select count(*)::int as n from dogfile.attempts where kind = ${kind} and who = ${who} and at > now() - make_interval(mins => ${minutes})`;
  if (n >= max) throw new HttpError(429, msg, 'rate_limited');
}
const note = (d: Deps, kind: string, who: string) => d.sql`insert into dogfile.attempts (kind, who) values (${kind}, ${who})`;

// ---------- trial ----------
export async function trial(d: Deps, body: any, ip: string) {
  const m = parseMachine(body?.machine);
  if (!m) throw bad('Unrecognised PC ID');
  const mt = machineText(m);
  await limit(d, 'trial', ip, 60, 60, 'Too many requests. Try again in an hour.');
  await note(d, 'trial', ip);
  // the first request for this PC fixes the start; later ones (reinstalls, new Windows user…) get the same dates
  await d.sql`insert into dogfile.trials (machine, app_version) values (${mt}, ${String(body?.version || '').slice(0, 20)}) on conflict (machine) do nothing`;
  const [t] = await d.sql`update dogfile.trials set last_seen = now() where machine = ${mt} returning started_at`;
  const start = secs(new Date(t.started_at).getTime());
  const end = start + TRIAL_DAYS * 86400;
  const k = await keys(d);
  const now = secs(d.now());
  return { token: await sign(k.priv, { kind: KIND_TRIAL, machine: m, issued: now, a: end, b: start }), start, end, now, days: TRIAL_DAYS };
}

// ---------- activation ----------
async function activateCore(d: Deps, serialIn: unknown, machineIn: unknown, name: unknown, who: string) {
  const m = parseMachine(machineIn);
  if (!m) throw bad('Unrecognised PC ID. Copy it again from Dogfile.');
  const mt = machineText(m);
  await limit(d, 'activate-fail', who, 10, 60, 'Too many wrong serial numbers. Try again in an hour.');
  await limit(d, 'activate-fail', mt, 10, 60, 'Too many wrong serial numbers. Try again in an hour.');
  const serial = normalizeSerial(serialIn);
  const fail = async (msg: string, code: string) => { await note(d, 'activate-fail', who); await note(d, 'activate-fail', mt); return new HttpError(400, msg, code); };
  if (!serial) throw await fail('That doesn’t look like a Dogfile serial number (DOGF-XXXXX-XXXXX-XXXXX-XXXXX).', 'bad_serial');
  const result = await d.sql.begin(async (tx: Sql) => {
    const [lic] = await tx`select * from dogfile.licenses where serial = ${serial} for update`;
    if (!lic) return { err: 'unknown' };
    if (lic.status !== 'active') return { err: 'revoked' };
    const [existing] = await tx`select id from dogfile.activations where license_id = ${lic.id} and machine = ${mt}`;
    if (existing) {
      await tx`update dogfile.activations set last_seen = now(), name = coalesce(${name ? String(name).slice(0, 80) : null}, name) where id = ${existing.id}`;
      return { lic, act: existing.id };
    }
    const [{ n }] = await tx`select count(*)::int as n from dogfile.activations where license_id = ${lic.id}`;
    if (n >= lic.max_machines) {
      const others = await tx`select name, created_at from dogfile.activations where license_id = ${lic.id} order by created_at`;
      return { err: 'full', others, max: lic.max_machines };
    }
    const [a] = await tx`insert into dogfile.activations (license_id, machine, name) values (${lic.id}, ${mt}, ${name ? String(name).slice(0, 80) : null}) returning id`;
    return { lic, act: a.id };
  });
  if (result.err === 'unknown') throw await fail('That serial number wasn’t found. Check it against the email you got after buying.', 'unknown_serial');
  if (result.err === 'revoked') throw new HttpError(400, 'This serial number has been cancelled (for example after a refund).', 'revoked');
  if (result.err === 'full') {
    const names = result.others.map((o: any) => o.name || 'a PC').join(' and ');
    throw new HttpError(409, `This serial number is already in use on ${result.max} PCs (${names}). Open Dogfile on one of them and choose Settings › Licence › Deactivate this PC, then try again.`, 'too_many_machines');
  }
  const k = await keys(d);
  const token = await sign(k.priv, { kind: KIND_LICENSE, machine: m, issued: secs(d.now()), a: Number(result.lic.id), b: Number(result.act) });
  return { token, serial, email: maskEmail(result.lic.email), machines: result.lic.max_machines };
}
export const activate = (d: Deps, body: any, ip: string) => activateCore(d, body?.serial, body?.machine, body?.name, ip);

/** offline activation: GET /offline?k=<serial>&m=<PC ID>, answered in plain text (or as a file with &download=1) */
export async function offline(d: Deps, q: URLSearchParams, ip: string) {
  try {
    const r = await activateCore(d, q.get('k'), q.get('m'), q.get('n') || 'Activated offline', ip);
    const code = group(r.token);
    if (q.get('download')) return { status: 200, file: true, text: code + '\r\n' };
    return {
      status: 200,
      text: `Dogfile Pro: activation code\n\n${code}\n\nType this code into Dogfile on the PC you're activating (Settings › Licence › Activate offline › Enter the activation code),\nor save it as a file and open it there: ${d.self}/offline?k=${encodeURIComponent(q.get('k') || '')}&m=${encodeURIComponent(q.get('m') || '')}&download=1\n\nThe code only works on that PC.\n`,
    };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'Something went wrong. Try again in a minute.';
    return { status: e instanceof HttpError ? e.status : 500, text: `Dogfile Pro: activation failed\n\n${msg}\n` };
  }
}

// ---------- deactivation and revalidation (the app sends its licence token) ----------
async function licenseFromToken(d: Deps, token: unknown) {
  const k = await keys(d);
  const c = typeof token === 'string' ? await verify(k.pub, token) : null;
  if (!c || c.kind !== KIND_LICENSE) throw bad('Not a Dogfile licence', 'bad_token');
  return c;
}
export async function deactivate(d: Deps, body: any) {
  const c = await licenseFromToken(d, body?.token);
  const mt = machineText(c.machine);
  const [{ n }] = await d.sql`select count(*)::int as n from dogfile.deactivations where license_id = ${c.a} and at > now() - interval '30 days'`;
  if (n >= DEACTIVATIONS_PER_30_DAYS) throw new HttpError(429, `This licence has been moved between PCs ${n} times in the last 30 days. Try again later, or contact support.`, 'rate_limited');
  const gone = await d.sql`delete from dogfile.activations where license_id = ${c.a} and machine = ${mt} returning id`;
  if (gone.length) await d.sql`insert into dogfile.deactivations (license_id, machine) values (${c.a}, ${mt})`;
  return { ok: true };
}
export async function validate(d: Deps, body: any) {
  const c = await licenseFromToken(d, body?.token);
  const mt = machineText(c.machine);
  const [lic] = await d.sql`select status from dogfile.licenses where id = ${c.a}`;
  if (!lic) return { ok: false, reason: 'unknown' };
  if (lic.status !== 'active') return { ok: false, reason: 'revoked' };
  const act = await d.sql`update dogfile.activations set last_seen = now() where license_id = ${c.a} and machine = ${mt} returning id`;
  if (!act.length) return { ok: false, reason: 'deactivated' };
  return { ok: true, now: secs(d.now()) };
}

// ---------- buying ----------
export async function checkout(d: Deps, body: any) {
  const m = parseMachine(body?.machine);
  // the serial number is chosen now so Stripe's own invoice and receipt email carry it (it only works once paid:
  // the licence row is created by fulfil)
  const serial = newSerial();
  const form: Record<string, string> = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(PRICE_CENTS),
    'line_items[0][price_data][product_data][name]': 'Dogfile Pro',
    'line_items[0][price_data][product_data][description]': 'Lifetime licence for 2 PCs. Your serial number is emailed to you.',
    // Stripe's product tax code (needed with Managed Payments): Downloadable Software - Personal Use, unless set otherwise
    'line_items[0][price_data][product_data][tax_code]': d.env('STRIPE_TAX_CODE') || 'txcd_10202000',
    success_url: (d.env('SUCCESS_URL') || `${d.self}/thanks`) + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: d.env('CANCEL_URL') || `${d.self}/cancelled`,
    'invoice_creation[enabled]': 'true',
    'invoice_creation[invoice_data][custom_fields][0][name]': 'Serial number',
    'invoice_creation[invoice_data][custom_fields][0][value]': serial,
    'invoice_creation[invoice_data][footer]': 'Activate in Dogfile: Settings > Licence > Enter serial number. Works on 2 PCs.',
    'metadata[serial]': serial,
    allow_promotion_codes: 'true',
    'metadata[product]': 'dogfile-pro',
  };
  if (m) form['metadata[machine]'] = machineText(m);
  await ensureWebhook(d).catch((e) => console.error('webhook setup', e));
  if (typeof body?.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) form.customer_email = body.email;
  let s = await d.stripe('POST', '/v1/checkout/sessions', form);
  // Managed Payments (Stripe as merchant of record) sends its own receipts and refuses invoice options: the serial
  // number then goes in the product description, which the checkout page and Stripe's receipt both show
  if (!s?.url && /managed payments/i.test(s?.error?.message || '')) {
    for (const k of Object.keys(form)) if (k.startsWith('invoice_creation')) delete form[k];
    form['line_items[0][price_data][product_data][description]'] = `Lifetime licence for 2 PCs. Serial number: ${serial} (Dogfile: Settings > Licence > Enter serial number)`;
    s = await d.stripe('POST', '/v1/checkout/sessions', form);
  }
  if (!s?.url) {
    console.error('stripe checkout', JSON.stringify(s?.error || s).slice(0, 500));
    throw new HttpError(502, 'The payment page couldn’t be opened. Try again in a minute.' + (s?.error?.message ? ` (Stripe: ${s.error.message})` : ''), 'stripe');
  }
  return { url: s.url, session: s.id };
}

/** a paid checkout becomes a licence (once, whichever of the webhook / the app / the thank-you page gets here first) */
export async function fulfil(d: Deps, session: any) {
  if (!session?.id || session.metadata?.product !== 'dogfile-pro') return null;
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return null;
  const email = session.customer_details?.email || session.customer_email || null;
  const serial = normalizeSerial(session.metadata?.serial) || newSerial();
  const ins = await d.sql`insert into dogfile.licenses (serial, email, stripe_session, stripe_payment_intent, amount_cents, currency, source)
    values (${serial}, ${email}, ${session.id}, ${session.payment_intent || null}, ${session.amount_total ?? null}, ${session.currency || null}, 'stripe')
    on conflict (stripe_session) do nothing returning id`;
  const [lic] = await d.sql`select * from dogfile.licenses where stripe_session = ${session.id}`;
  if (ins.length && email) await sendSerial(d, lic);
  return lic;
}
async function sessionLicense(d: Deps, id: string | null) {
  if (!id || !/^cs_[A-Za-z0-9_]+$/.test(id)) throw bad('Unknown checkout');
  const [lic] = await d.sql`select * from dogfile.licenses where stripe_session = ${id}`;
  if (lic) return lic;
  const s = await d.stripe('GET', `/v1/checkout/sessions/${id}`);
  return await fulfil(d, s);
}
/** the app polls this after opening the payment page: the serial number once paid */
export async function claim(d: Deps, q: URLSearchParams) {
  const lic = await sessionLicense(d, q.get('session'));
  if (!lic) return { pending: true };
  if (lic.status !== 'active') return { pending: false, error: 'This purchase was refunded or cancelled.' };
  return { serial: lic.serial, email: maskEmail(lic.email) };
}
export async function thanks(d: Deps, q: URLSearchParams) {
  try {
    const lic = await sessionLicense(d, q.get('session_id'));
    if (!lic) return `Dogfile Pro\n\nThanks! Your payment is being confirmed. Your serial number will arrive by email in a minute or two,\nand Dogfile activates by itself if it's open.\n`;
    return `Dogfile Pro: thank you!\n\nYour serial number:  ${lic.serial}\n\n${lic.email ? `We've also emailed it to ${lic.email}.\n` : ''}If Dogfile is open, it has already activated itself. Otherwise open Dogfile, choose Settings › Licence ›\nEnter serial number, and paste it in. It works on 2 PCs.\n\nYou can close this tab.\n`;
  } catch {
    return `Dogfile Pro\n\nThanks for your purchase. Your serial number will arrive by email.\n`;
  }
}

// ---------- Stripe webhook ----------
/** test and live keys each get their own webhook; made the first time someone opens checkout with that key */
const hookKey = (d: Deps) => `stripe_webhook_secret_${(d.env('STRIPE_SECRET_KEY') || '').startsWith('sk_live') ? 'live' : 'test'}`;
export async function ensureWebhook(d: Deps) {
  if (!d.env('STRIPE_SECRET_KEY') || d.env('STRIPE_WEBHOOK_SECRET')) return 'not needed';
  const [row] = await d.sql`select value from dogfile.config where key = ${hookKey(d)}`;
  if (row) return 'already set up';
  const w = await d.stripe('POST', '/v1/webhook_endpoints', {
    url: `${d.self}/webhook`, description: 'Dogfile licences',
    'enabled_events[0]': 'checkout.session.completed', 'enabled_events[1]': 'checkout.session.async_payment_succeeded',
    'enabled_events[2]': 'charge.refunded', 'enabled_events[3]': 'charge.dispute.created',
  });
  if (!w?.secret) throw new HttpError(502, 'Stripe didn’t create the webhook: ' + JSON.stringify(w).slice(0, 300), 'stripe');
  await d.sql`insert into dogfile.config (key, value) values (${hookKey(d)}, ${w.secret}) on conflict (key) do nothing`;
  return 'created ' + w.id;
}
export async function verifyStripeSignature(secret: string, header: string | null, raw: string, nowS: number) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(nowS - t) > 600 || !sigs.length) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].reduce((acc, ch, i) => acc | (ch.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}
export async function webhook(d: Deps, raw: string, sigHeader: string | null) {
  const [row] = await d.sql`select value from dogfile.config where key = ${hookKey(d)}`;
  const secret = d.env('STRIPE_WEBHOOK_SECRET') || row?.value;
  if (!secret || !(await verifyStripeSignature(secret, sigHeader, raw, secs(d.now())))) throw new HttpError(400, 'Bad signature', 'bad_signature');
  const ev = JSON.parse(raw);
  const o = ev.data?.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await fulfil(d, o);
      break;
    case 'charge.refunded':
      if (o?.payment_intent && o.refunded) await d.sql`update dogfile.licenses set status = 'revoked', revoked_reason = 'refunded' where stripe_payment_intent = ${o.payment_intent}`;
      break;
    case 'charge.dispute.created':
      if (o?.payment_intent) await d.sql`update dogfile.licenses set status = 'revoked', revoked_reason = 'disputed' where stripe_payment_intent = ${o.payment_intent}`;
      break;
  }
  return { received: true };
}

// ---------- email ----------
export function maskEmail(e: string | null) {
  if (!e) return null;
  const [u, dom] = e.split('@');
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${dom}`;
}
export async function sendSerial(d: Deps, lic: any) {
  if (!lic?.email) return false;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;color:#1d1d1f">
<h2 style="margin:0 0 12px">Thanks for buying Dogfile Pro!</h2>
<p>Your serial number:</p>
<p style="font-size:20px;font-weight:600;letter-spacing:1px;background:#f2f4f7;padding:14px 16px;border-radius:8px;font-family:Consolas,monospace">${esc(lic.serial)}</p>
<p><b>To activate:</b> open Dogfile, choose <b>Settings › Licence › Enter serial number</b>, and paste it in.
If Dogfile was open when you paid, it has already activated itself.</p>
<p>Your licence works on <b>2 PCs</b>. To move it to another PC, open Dogfile on the old one and choose
<b>Settings › Licence › Deactivate this PC</b>.</p>
<p style="color:#666;font-size:13px">Keep this email: you'll need the serial number if you reinstall Windows.</p></div>`;
  const text = `Thanks for buying Dogfile Pro!\n\nYour serial number: ${lic.serial}\n\nTo activate: open Dogfile, choose Settings > Licence > Enter serial number, and paste it in.\nYour licence works on 2 PCs. To move it, choose Settings > Licence > Deactivate this PC on the old PC.\n`;
  const ok = await d.email(lic.email, 'Your Dogfile Pro serial number', html, text);
  if (ok) await d.sql`update dogfile.licenses set email_sent_at = now() where id = ${lic.id}`;
  return ok;
}

// ---------- admin (header x-admin-secret) ----------
export async function admin(d: Deps, route: string, body: any, secret: string | null) {
  const want = d.env('ADMIN_SECRET');
  if (!want || want.length < 12 || secret !== want) throw new HttpError(401, 'Not allowed', 'unauthorized');
  switch (route) {
    case 'setup': {
      const k = await keys(d);
      return { pubkey: k.pubText, api: d.self, webhook: d.env('STRIPE_SECRET_KEY') ? await ensureWebhook(d) : 'no STRIPE_SECRET_KEY yet' };
    }
    case 'issue': {
      const serial = newSerial();
      const [lic] = await d.sql`insert into dogfile.licenses (serial, email, source, note, max_machines) values (${serial}, ${body?.email || null}, 'admin', ${body?.note || null}, ${Number(body?.machines) || 2}) returning *`;
      const sent = body?.email && body?.send !== false ? await sendSerial(d, lic) : false;
      return { serial, emailed: sent };
    }
    case 'revoke': {
      const s = normalizeSerial(body?.serial);
      const r = await d.sql`update dogfile.licenses set status = 'revoked', revoked_reason = ${body?.reason || 'admin'} where serial = ${s} returning id`;
      return { revoked: r.length };
    }
    case 'restore': {
      const s = normalizeSerial(body?.serial);
      const r = await d.sql`update dogfile.licenses set status = 'active', revoked_reason = null where serial = ${s} returning id`;
      return { restored: r.length };
    }
    case 'lookup': {
      const s = normalizeSerial(body?.serial);
      const lic = s ? await d.sql`select * from dogfile.licenses where serial = ${s}` : await d.sql`select * from dogfile.licenses where lower(email) = lower(${body?.email || ''}) order by id`;
      const ids = lic.map((l: any) => l.id);
      const acts = ids.length ? await d.sql`select license_id, name, machine, created_at, last_seen from dogfile.activations where license_id = any(${ids})` : [];
      return { licenses: lic, activations: acts };
    }
    case 'resend': {
      const s = normalizeSerial(body?.serial);
      const [lic] = await d.sql`select * from dogfile.licenses where serial = ${s}`;
      return { emailed: lic ? await sendSerial(d, lic) : false };
    }
    case 'free-slot': {
      // remove a PC from a licence (e.g. the customer's old PC died)
      const s = normalizeSerial(body?.serial);
      const r = await d.sql`delete from dogfile.activations where license_id = (select id from dogfile.licenses where serial = ${s}) and (${body?.machine || null}::text is null or machine = ${body?.machine || null}) returning id`;
      return { removed: r.length };
    }
  }
  throw new HttpError(404, 'Unknown admin route', 'not_found');
}

export { machineText };
