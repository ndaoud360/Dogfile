// Dogfile licence server, one Supabase Edge Function. Routes (after /functions/v1/license):
//   GET  /pubkey                      the public key the app checks signatures with
//   POST /trial      {machine, version}                 → signed trial token (one trial per PC, ever)
//   POST /activate   {serial, machine, name}            → signed licence token (2 PCs per serial)
//   GET  /offline?k=<serial>&m=<PC ID>[&download=1]     → the same, as text to type in on an offline PC
//   POST /deactivate {token}  ·  POST /validate {token}
//   POST /checkout   {machine?, email?}                 → Stripe payment page
//   GET  /claim?session=cs_…  ·  GET /thanks?session_id=cs_…  ·  GET /cancelled
//   POST /webhook                                       Stripe events (paid, refunded, disputed)
//   POST /admin/<setup|issue|revoke|restore|lookup|resend|free-slot>   header x-admin-secret: ADMIN_SECRET
//   GET  /status                                        what is set up (never the values)
// Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY, RESEND_FROM, ADMIN_SECRET (SUPABASE_DB_URL is provided by Supabase).
import postgres from 'npm:postgres@3.4.5';
import * as core from './core.ts';

const env = (k: string) => Deno.env.get(k);
const sql = postgres(env('SUPABASE_DB_URL')!, { prepare: false, max: 3, idle_timeout: 20 });

const stripe = async (method: string, path: string, form?: Record<string, string>) => {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new core.HttpError(503, 'Payments aren’t set up yet.', 'no_stripe');
  const r = await fetch((env('STRIPE_API') || 'https://api.stripe.com') + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return await r.json();
};
const email = async (to: string, subject: string, html: string, text: string) => {
  const key = env('RESEND_API_KEY');
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env('RESEND_FROM') || 'Dogfile <onboarding@resend.dev>', to: [to], subject, html, text, reply_to: env('SUPPORT_EMAIL') || undefined }),
  });
  if (!r.ok) console.error('email failed', r.status, (await r.text()).slice(0, 300));
  return r.ok;
};

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-admin-secret', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...CORS } });
const text = (t: string, status = 200, extra: Record<string, string> = {}) => new Response(t, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS, ...extra } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*?\/license/, '').replace(/\/+$/, '') || '/';
  const self = (env('PUBLIC_URL') || `${env('SUPABASE_URL')}/functions/v1/license`).replace(/\/+$/, '');
  const d: core.Deps = { sql, env, stripe, email, now: () => Date.now(), self };
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  try {
    switch (`${req.method} ${route}`) {
      case 'GET /': return text('Dogfile licence server\n');
      case 'GET /pubkey': return json({ pubkey: (await core.keys(d)).pubText });
      // what's set up (never the values): for checking the configuration
      case 'GET /status': {
        const k = env('STRIPE_SECRET_KEY') || '';
        const names = Object.keys(Deno.env.toObject()).filter((n) => /stripe|resend/i.test(n)).sort();
        return json({ stripe: k ? (k.startsWith('sk_live_') ? 'live' : k.startsWith('sk_test_') ? 'test' : k.startsWith('rk_') ? 'restricted key' : k.startsWith('pk_') ? 'publishable key (wrong kind)' : 'unrecognised') : null, email: !!env('RESEND_API_KEY'), settings: names });
      }
      case 'POST /trial': return json(await core.trial(d, await body(), ip));
      case 'POST /activate': return json(await core.activate(d, await body(), ip));
      case 'GET /offline': {
        const r = await core.offline(d, url.searchParams, ip);
        return text(r.text, r.status, r.file ? { 'content-disposition': 'attachment; filename="Dogfile activation code.txt"' } : {});
      }
      case 'POST /deactivate': return json(await core.deactivate(d, await body()));
      case 'POST /validate': return json(await core.validate(d, await body()));
      case 'POST /checkout': return json(await core.checkout(d, await body()));
      case 'GET /claim': return json(await core.claim(d, url.searchParams));
      case 'GET /thanks': return text(await core.thanks(d, url.searchParams));
      case 'GET /cancelled': return text('Dogfile Pro\n\nThe payment was cancelled; nothing was charged. You can close this tab.\n');
      case 'POST /webhook': return json(await core.webhook(d, await req.text(), req.headers.get('stripe-signature')));
    }
    if (req.method === 'POST' && route.startsWith('/admin/')) return json(await core.admin(d, route.slice(7), await body(), req.headers.get('x-admin-secret')));
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof core.HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on the licence server. Try again in a minute.', code: 'server' }, 500);
  }
});
