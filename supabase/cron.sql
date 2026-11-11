-- Deal-watcher schedule (owner: B). NOT a migration: run once in the Supabase SQL editor AFTER deploying to Vercel.
-- Why not Vercel Cron? Vercel Hobby only allows cron jobs once per day.
-- Requires extensions pg_cron + pg_net (Dashboard → Database → Extensions).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the secret in Supabase Vault instead of hard-coding it in the job.
-- Use the SAME value as CRON_SECRET in Vercel env.
select vault.create_secret('<paste CRON_SECRET here>', 'dealhound_cron_secret');

select cron.schedule(
  'dealhound-scan',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<your-app>.vercel.app/api/scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'dealhound_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Inspect / stop:
-- select * from cron.job;
-- select * from cron.job_run_details order by start_time desc limit 20;
-- select cron.unschedule('dealhound-scan');
