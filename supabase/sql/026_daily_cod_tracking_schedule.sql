-- Daily SLPOST status refresh for dispatched COD orders.
-- Run after 025_cod_courier_tracking.sql and after creating these Vault secrets:
--   cod_tracking_project_url        = https://YOUR-PROJECT-REF.supabase.co
--   cod_tracking_service_role_key   = your Supabase secret/service-role key

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.invoke_daily_cod_tracking_v26()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  project_url text;
  service_role_key text;
  request_id bigint;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'cod_tracking_project_url'
  order by created_at desc
  limit 1;

  select decrypted_secret into service_role_key
  from vault.decrypted_secrets
  where name = 'cod_tracking_service_role_key'
  order by created_at desc
  limit 1;

  if nullif(trim(coalesce(project_url, '')), '') is null
     or nullif(trim(coalesce(service_role_key, '')), '') is null then
    raise exception 'Create cod_tracking_project_url and cod_tracking_service_role_key in Supabase Vault first';
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/track-slpost',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', service_role_key,
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := '{"syncAll":true}'::jsonb
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_daily_cod_tracking_v26() from public;
revoke all on function public.invoke_daily_cod_tracking_v26() from anon;
revoke all on function public.invoke_daily_cod_tracking_v26() from authenticated;

-- 02:30 UTC is 08:00 in Sri Lanka (UTC+05:30).
select cron.schedule(
  'cod-tracking-daily',
  '30 2 * * *',
  'select public.invoke_daily_cod_tracking_v26();'
);

