-- v31: Daily logical app backups, restore support, and document party safeguards.
-- Run once after 030_company_branding_a5_printing.sql.
--
-- These snapshots protect the POS application data inside this Supabase project.
-- Keep Supabase managed database backups enabled as a separate disaster-recovery layer.

create extension if not exists pgcrypto;

create table if not exists public.app_backups (
  id uuid primary key default gen_random_uuid(),
  backup_date date not null default (timezone('Asia/Colombo', now()))::date,
  backup_type text not null default 'manual'
    check (backup_type in ('daily', 'manual', 'pre_restore')),
  status text not null default 'ready'
    check (status in ('ready', 'restored', 'failed')),
  schema_version integer not null default 31,
  snapshot jsonb not null,
  row_counts jsonb not null default '{}'::jsonb,
  snapshot_size_bytes bigint not null default 0,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  restored_by uuid references auth.users(id) on delete set null,
  restored_at timestamptz
);

create unique index if not exists app_backups_one_daily_per_date_idx
  on public.app_backups(backup_date)
  where backup_type = 'daily';

create index if not exists app_backups_created_at_idx
  on public.app_backups(created_at desc);

alter table public.app_backups enable row level security;

drop policy if exists "authenticated read app backups" on public.app_backups;
create policy "authenticated read app backups"
  on public.app_backups for select to authenticated using (true);

-- Backup rows can only be created/changed through the functions below.
revoke insert, update, delete on public.app_backups from authenticated;
grant select on public.app_backups to authenticated;

create or replace function public.create_app_backup_v31(
  p_backup_type text default 'manual',
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_id uuid;
  local_date date := (timezone('Asia/Colombo', now()))::date;
  backup_kind text := lower(trim(coalesce(p_backup_type, 'manual')));
  snapshot_payload jsonb;
  counts_payload jsonb;
begin
  if backup_kind not in ('daily', 'manual', 'pre_restore') then
    raise exception 'Unsupported backup type: %', backup_kind;
  end if;

  snapshot_payload := jsonb_build_object(
    'categories', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.categories x), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.brands x), '[]'::jsonb),
    'payment_methods', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.payment_methods x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.products x), '[]'::jsonb),
    'stock_balances', coalesce((select jsonb_agg(to_jsonb(x) order by x.product_id) from public.stock_balances x), '[]'::jsonb),
    'customers', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.customers x), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.suppliers x), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.staff x), '[]'::jsonb),
    'company_settings', coalesce((select jsonb_agg(to_jsonb(x)) from public.company_settings x), '[]'::jsonb),
    'pos_drafts', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.pos_drafts x), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.documents x), '[]'::jsonb),
    'document_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.document_items x), '[]'::jsonb),
    'cashflow_entries', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.cashflow_entries x), '[]'::jsonb),
    'stock_movements', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.stock_movements x), '[]'::jsonb),
    'document_sequences', coalesce((select jsonb_agg(to_jsonb(x) order by x.document_type, x.document_year) from public.document_sequences x), '[]'::jsonb),
    'product_assemblies', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.product_assemblies x), '[]'::jsonb),
    'product_assembly_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.product_assembly_items x), '[]'::jsonb)
  );

  counts_payload := jsonb_build_object(
    'products', (select count(*) from public.products),
    'customers', (select count(*) from public.customers),
    'suppliers', (select count(*) from public.suppliers),
    'documents', (select count(*) from public.documents),
    'document_items', (select count(*) from public.document_items),
    'cashflow_entries', (select count(*) from public.cashflow_entries),
    'stock_movements', (select count(*) from public.stock_movements),
    'assemblies', (select count(*) from public.product_assemblies)
  );

  if backup_kind = 'daily' then
    insert into public.app_backups (
      backup_date, backup_type, snapshot, row_counts, snapshot_size_bytes,
      notes, created_by
    ) values (
      local_date, backup_kind, snapshot_payload, counts_payload,
      pg_column_size(snapshot_payload), nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
    )
    on conflict (backup_date) where backup_type = 'daily'
    do update set
      snapshot = excluded.snapshot,
      row_counts = excluded.row_counts,
      snapshot_size_bytes = excluded.snapshot_size_bytes,
      notes = excluded.notes,
      created_by = excluded.created_by,
      created_at = now(),
      status = 'ready',
      schema_version = 31
    returning id into backup_id;
  else
    insert into public.app_backups (
      backup_date, backup_type, snapshot, row_counts, snapshot_size_bytes,
      notes, created_by
    ) values (
      local_date, backup_kind, snapshot_payload, counts_payload,
      pg_column_size(snapshot_payload), nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
    ) returning id into backup_id;
  end if;

  return backup_id;
end;
$$;

create or replace function public.ensure_daily_app_backup_v31()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_id uuid;
  local_date date := (timezone('Asia/Colombo', now()))::date;
begin
  select id into backup_id
  from public.app_backups
  where backup_type = 'daily' and backup_date = local_date;

  if backup_id is null then
    backup_id := public.create_app_backup_v31('daily', 'Automatic daily application snapshot');
  end if;

  return backup_id;
end;
$$;

create or replace function public.restore_app_backup_v31(p_backup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  chosen public.app_backups%rowtype;
  safety_backup_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to restore a backup';
  end if;

  select * into chosen
  from public.app_backups
  where id = p_backup_id
  for update;

  if not found then raise exception 'Backup not found'; end if;
  if chosen.status not in ('ready', 'restored') then raise exception 'This backup is not ready to restore'; end if;

  -- Always preserve the current state first. The complete restore is one
  -- PostgreSQL transaction, so any failure rolls everything back.
  safety_backup_id := public.create_app_backup_v31(
    'pre_restore',
    'Automatic safety snapshot before restoring ' || chosen.id::text
  );

  perform set_config('shop_pos.restore_mode', 'on', true);

  delete from public.cashflow_entries;
  delete from public.stock_movements;
  delete from public.document_items;
  delete from public.product_assembly_items;
  delete from public.pos_drafts;
  delete from public.documents;
  delete from public.stock_balances;
  delete from public.product_assemblies;
  delete from public.products;
  update public.categories set parent_id = null where parent_id is not null;
  delete from public.categories;
  delete from public.brands;
  delete from public.payment_methods;
  delete from public.customers;
  delete from public.suppliers;
  delete from public.staff;
  delete from public.company_settings;
  delete from public.document_sequences;

  insert into public.categories select * from jsonb_populate_recordset(null::public.categories, coalesce(chosen.snapshot -> 'categories', '[]'::jsonb));
  insert into public.brands select * from jsonb_populate_recordset(null::public.brands, coalesce(chosen.snapshot -> 'brands', '[]'::jsonb));
  insert into public.payment_methods select * from jsonb_populate_recordset(null::public.payment_methods, coalesce(chosen.snapshot -> 'payment_methods', '[]'::jsonb));
  insert into public.customers select * from jsonb_populate_recordset(null::public.customers, coalesce(chosen.snapshot -> 'customers', '[]'::jsonb));
  insert into public.suppliers select * from jsonb_populate_recordset(null::public.suppliers, coalesce(chosen.snapshot -> 'suppliers', '[]'::jsonb));
  insert into public.staff select * from jsonb_populate_recordset(null::public.staff, coalesce(chosen.snapshot -> 'staff', '[]'::jsonb));
  insert into public.company_settings select * from jsonb_populate_recordset(null::public.company_settings, coalesce(chosen.snapshot -> 'company_settings', '[]'::jsonb));
  insert into public.products select * from jsonb_populate_recordset(null::public.products, coalesce(chosen.snapshot -> 'products', '[]'::jsonb));
  insert into public.stock_balances select * from jsonb_populate_recordset(null::public.stock_balances, coalesce(chosen.snapshot -> 'stock_balances', '[]'::jsonb));
  insert into public.product_assemblies select * from jsonb_populate_recordset(null::public.product_assemblies, coalesce(chosen.snapshot -> 'product_assemblies', '[]'::jsonb));
  insert into public.product_assembly_items select * from jsonb_populate_recordset(null::public.product_assembly_items, coalesce(chosen.snapshot -> 'product_assembly_items', '[]'::jsonb));
  insert into public.pos_drafts select * from jsonb_populate_recordset(null::public.pos_drafts, coalesce(chosen.snapshot -> 'pos_drafts', '[]'::jsonb));
  insert into public.documents select * from jsonb_populate_recordset(null::public.documents, coalesce(chosen.snapshot -> 'documents', '[]'::jsonb));
  insert into public.document_items select * from jsonb_populate_recordset(null::public.document_items, coalesce(chosen.snapshot -> 'document_items', '[]'::jsonb));
  insert into public.stock_movements select * from jsonb_populate_recordset(null::public.stock_movements, coalesce(chosen.snapshot -> 'stock_movements', '[]'::jsonb));
  insert into public.cashflow_entries select * from jsonb_populate_recordset(null::public.cashflow_entries, coalesce(chosen.snapshot -> 'cashflow_entries', '[]'::jsonb));
  insert into public.document_sequences select * from jsonb_populate_recordset(null::public.document_sequences, coalesce(chosen.snapshot -> 'document_sequences', '[]'::jsonb));

  update public.app_backups
  set status = 'restored', restored_by = auth.uid(), restored_at = now()
  where id = chosen.id;

  return jsonb_build_object(
    'restored_backup_id', chosen.id,
    'restored_backup_date', chosen.backup_date,
    'safety_backup_id', safety_backup_id
  );
end;
$$;

-- UI and server-side protection for party/balance rules. Restore explicitly
-- enables a transaction-local bypass so historical snapshots remain restorable.
create or replace function public.validate_document_party_v31()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('shop_pos.restore_mode', true) = 'on' then return new; end if;

  if new.document_type in ('purchase', 'stock_in_transit')
     and new.supplier_id is null and new.customer_id is null then
    raise exception 'Select a supplier/customer profile before saving this purchase';
  end if;

  if new.document_type in ('invoice', 'refund')
     and new.customer_id is null
     and (abs(coalesce(new.balance_amount, 0)) > 0.005 or coalesce(new.total_amount, 0) < 0) then
    raise exception 'Walk-in customer cannot be used for credit, balance, overpayment, or refund documents';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_document_party_v31 on public.documents;
create trigger validate_document_party_v31
before insert or update of document_type, supplier_id, customer_id, total_amount, balance_amount
on public.documents
for each row execute function public.validate_document_party_v31();

revoke all on function public.create_app_backup_v31(text, text) from public;
revoke all on function public.ensure_daily_app_backup_v31() from public;
revoke all on function public.restore_app_backup_v31(uuid) from public;
grant execute on function public.create_app_backup_v31(text, text) to authenticated;
grant execute on function public.ensure_daily_app_backup_v31() to authenticated;
grant execute on function public.restore_app_backup_v31(uuid) to authenticated;

-- Supabase projects normally provide pg_cron. If it is unavailable, the app
-- still creates the day's snapshot the first time an authenticated user opens it.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is unavailable; daily backups will run when the app is opened: %', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'shop-pos-daily-app-backup-v31';

    perform cron.schedule(
      'shop-pos-daily-app-backup-v31',
      '30 18 * * *',
      'select public.create_app_backup_v31(''daily'', ''Automatic daily application snapshot'');'
    );
  end if;
exception when others then
  raise notice 'Could not schedule pg_cron backup; app-open fallback remains active: %', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';
