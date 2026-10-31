// Dogfile licence server, one Supabase Edge Function. Routes (after /functions/v1/license):
//   GET  /pubkey                      the public key the app checks signatures with
//   POST /trial      {machine, version}                 → signed trial token (one trial per PC, ever)
//   POST /activate   {serial, machine, name}            → signed licence token (2 PCs per serial)
//   GET  /offline?k=<serial>&m=<PC ID>[&download=1]     → the same, as text to type in on an offline PC
//   POST /deactivate {token}  ·  POST /validate {token}
//   POST /checkout   {machine?, email?}                 → Stripe payment page
//   GET  /buy                                           → redirects to a new Stripe payment page (the website)
//   GET  /claim?session=cs_…  ·  GET /thanks?session_id=cs_…  ·  GET /cancelled
//   POST /contact    {name, email, message, kind?, details?}  → saved in dogfile.messages, then forwarded by email
//   POST /webhook                                       Stripe events (paid, refunded, disputed)
//   POST /admin/<setup|issue|revoke|restore|lookup|resend|free-slot|messages>   header x-admin-secret: ADMIN_SECRET
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
const email = async (to: string, subject: string, html: string, text: string, replyTo?: string) => {
  const key = env('RESEND_API_KEY');
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env('RESEND_FROM') || 'Dogfile <onboarding@resend.dev>', to: [to], subject, html, text, reply_to: replyTo || env('SUPPORT_EMAIL') || undefined }),
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
  // the caller's address as Cloudflare saw it (Supabase sits behind Cloudflare, which sets this header itself, so a
  // client can't fake it the way it can put anything at the front of X-Forwarded-For); used for rate limits
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',').pop()!.trim() || 'unknown';
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  try {
    switch (`${req.method} ${route}`) {
      case 'GET /': return text('Dogfile license server\n');
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
      case 'POST /deactivate': return json(await core.deactivate(d, await body(), ip));
      case 'POST /validate': return json(await core.validate(d, await body(), ip));
      case 'POST /checkout': await core.checkoutLimit(d, ip); return json(await core.checkout(d, await body()));
      // the website's Buy buttons are plain links to here: straight on to Stripe, no script needed
      case 'GET /buy': {
        const noStore = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
        // the site the Buy button is on (the link says so; the Referer is the fallback)
        const site = url.searchParams.get('site') || req.headers.get('referer') || '';
        try {
          await core.checkoutLimit(d, ip);
          const r = await core.checkout(d, { site });
          return new Response(null, { status: 303, headers: { location: r.url, ...noStore } });
        } catch (e) {
          console.error('buy', e);
          // back to the website, which explains that nothing was charged
          let u: URL | null = null;
          const base = core.siteBase(d, site);
          try { u = new URL(base ? `${base}download.html` : env('CANCEL_URL') || ''); } catch { /* not set */ }
          if (u) {
            u.searchParams.delete('cancelled');
            u.searchParams.set('failed', '1');
            return new Response(null, { status: 303, headers: { location: u.toString(), ...noStore } });
          }
          const msg = e instanceof core.HttpError ? e.message : 'The payment page couldn’t be opened. Try again in a minute.';
          return text(`Dogfile Pro\n\n${msg}\nNothing was charged.\n`, 502, noStore);
        }
      }
      case 'GET /claim': return json(await core.claim(d, url.searchParams, ip));
      case 'GET /thanks': return text(await core.thanks(d, url.searchParams, ip));
      case 'GET /cancelled': return text('Dogfile Pro\n\nThe payment was cancelled; nothing was charged. You can close this tab.\n');
      // the website's contact form and the app's "Report a bug"
      case 'POST /contact': return json(await core.contact(d, await body(), ip));
      case 'POST /webhook': return json(await core.webhook(d, await req.text(), req.headers.get('stripe-signature')));
    }
    if (req.method === 'POST' && route.startsWith('/admin/')) return json(await core.admin(d, route.slice(7), await body(), req.headers.get('x-admin-secret'), ip));
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof core.HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on the license server. Try again in a minute.', code: 'server' }, 500);
  }
});
