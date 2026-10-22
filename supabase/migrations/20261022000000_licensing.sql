-- Dogfile Pro licences, in their own schema (not exposed through the Supabase API). Only the licence function (service role / database connection) reads or writes these:
-- row level security is on with no policies, so the public API keys can't see anything.

create schema if not exists dogfile;

create table if not exists dogfile.licenses (
  id            bigserial primary key,
  serial        text not null unique,             -- DOGF-XXXXX-XXXXX-XXXXX-XXXXX
  email         text,
  status        text not null default 'active',   -- active | revoked
  max_machines  int  not null default 2,
  source        text not null default 'stripe',   -- stripe | admin
  stripe_session text unique,
  stripe_payment_intent text,
  amount_cents  int,
  currency      text,
  note          text,
  email_sent_at timestamptz,
  revoked_reason text,
  created_at    timestamptz not null default now()
);
create index if not exists licenses_email on dogfile.licenses (lower(email));
create index if not exists licenses_pi on dogfile.licenses (stripe_payment_intent);

create table if not exists dogfile.activations (
  id          bigserial primary key,
  license_id  bigint not null references dogfile.licenses(id) on delete cascade,
  machine     text not null,                      -- the PC's ID (a hash, nothing personal)
  name        text,                               -- the PC's name, so the owner can tell them apart
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (license_id, machine)
);

create table if not exists dogfile.deactivations (
  id          bigserial primary key,
  license_id  bigint not null references dogfile.licenses(id) on delete cascade,
  machine     text not null,
  at          timestamptz not null default now()
);

-- one trial per PC, ever: the first request fixes the start date
create table if not exists dogfile.trials (
  machine     text primary key,
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  app_version text
);

-- attempts, for rate limits (activations with wrong serial numbers, trial requests)
create table if not exists dogfile.attempts (
  id     bigserial primary key,
  kind   text not null,
  who    text not null,
  at     timestamptz not null default now()
);
create index if not exists attempts_lookup on dogfile.attempts (kind, who, at);

-- the signing key and the Stripe webhook secret, created by the function itself
create table if not exists dogfile.config (
  key   text primary key,
  value text not null
);

alter table dogfile.licenses      enable row level security;
alter table dogfile.activations   enable row level security;
alter table dogfile.deactivations enable row level security;
alter table dogfile.trials        enable row level security;
alter table dogfile.attempts      enable row level security;
alter table dogfile.config        enable row level security;
revoke all on all tables in schema dogfile from anon, authenticated;
revoke all on schema dogfile from anon, authenticated, public;
