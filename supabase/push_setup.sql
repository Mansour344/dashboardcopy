-- =============================================================
-- Push reminders — database setup.
-- Run this once in the Supabase SQL editor (or via the CLI).
-- Mirrors the anon-access style already used by public.app_state.
-- =============================================================

-- 1) Subscriptions: one row per installed device that opted in.
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  timezone   text not null default 'UTC',
  updated_at timestamptz not null default now()
);

-- 2) Dedup log: one row per reminder actually sent, so the
--    every-minute cron never double-sends the same reminder.
create table if not exists public.reminder_log (
  reminder_key text primary key,   -- "<date>|<kind>|<slug(text)>"
  sent_at      timestamptz not null default now()
);

-- ---- Row Level Security (anon, matching app_state) ----
alter table public.push_subscriptions enable row level security;
alter table public.reminder_log       enable row level security;

-- push_subscriptions: the browser (anon) needs insert/select/update/delete.
drop policy if exists "anon_all_push_subscriptions" on public.push_subscriptions;
create policy "anon_all_push_subscriptions" on public.push_subscriptions
  for all to anon using (true) with check (true);

-- reminder_log: written by the Edge Function (service role bypasses RLS),
-- but allow anon select for debugging. No anon writes needed.
drop policy if exists "anon_select_reminder_log" on public.reminder_log;
create policy "anon_select_reminder_log" on public.reminder_log
  for select to anon using (true);

-- Optional: auto-purge old dedup rows (keep 3 days) to stay tidy.
-- Safe to skip; the table stays small either way.

-- =============================================================
-- 3) Cron: call the Edge Function every minute.
--    Requires the pg_cron and pg_net extensions.
--    Replace <PROJECT_REF> and <ANON_OR_SERVICE_KEY> below, then run.
-- =============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous schedule with the same name before re-adding.
select cron.unschedule('send-reminders-every-minute')
where exists (select 1 from cron.job where jobname = 'send-reminders-every-minute');

select cron.schedule(
  'send-reminders-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/send-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <ANON_OR_SERVICE_KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To verify the cron is firing:
--   select * from cron.job_run_details order by start_time desc limit 10;
