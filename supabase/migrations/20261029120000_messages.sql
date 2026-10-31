-- Messages from the website's contact form and the app's "Report a bug": saved here first, so none is ever lost even
-- when forwarding them by email fails. Read them in the Supabase dashboard (Table Editor > schema "dogfile" > messages)
-- or with POST /admin/messages. Like every table here: row level security on, no policies (only the function reads it).
create table if not exists dogfile.messages (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  kind       text not null default 'contact',   -- contact | bug
  name       text not null,
  email      text not null,
  subject    text,
  message    text not null,
  details    jsonb,                              -- a bug report's app version, Windows version, recent errors, mod
  ip         text,
  forwarded  text                                -- how it reached the inbox: "resend", "formsubmit", or why it didn't
);
alter table dogfile.messages enable row level security;
create index if not exists messages_at on dogfile.messages (at desc);
