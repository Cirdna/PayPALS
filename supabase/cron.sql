-- Deal-watcher schedule (owner: B). NOT a migration: run ONCE in the Supabase SQL editor AFTER the first Vercel deploy.
-- Why not Vercel Cron? Vercel Hobby only allows cron jobs once per day.
-- First enable the extensions pg_cron and pg_net (Dashboard → Database → Extensions).
-- Replace BOTH placeholders below before running: <CRON_SECRET> and <APP_URL>.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Same value as CRON_SECRET in the Vercel environment variables. Stored in Supabase Vault, not in the job text.
select vault.create_secret('<CRON_SECRET>', 'dealhound_cron_secret');

select cron.schedule(
  'dealhound-scan',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dealhound_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it works:   select * from cron.job_run_details order by start_time desc limit 5;
--                   select status_code, content from net._http_response order by created desc limit 5;
-- Stop it:          select cron.unschedule('dealhound-scan');
