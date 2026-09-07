-- v62: Keep Start Fresh compatible with the cheque-payment tables added in v56.
-- Run once after 061_party_profile_editing.sql.

begin;

-- Cheque records are business data tied to documents. Add them to logical
-- backups so a safety backup made before Start Fresh remains complete.
create or replace function public.augment_start_fresh_backup_v62()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object(
    'cheque_payments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at, x.id)
      from public.cheque_payments x
    ), '[]'::jsonb)
  );
  new.row_counts := coalesce(new.row_counts, '{}'::jsonb) || jsonb_build_object(
    'cheque_payments', (select count(*) from public.cheque_payments)
  );
  new.schema_version := greatest(coalesce(new.schema_version, 31), 62);
  new.snapshot_size_bytes := pg_column_size(new.snapshot);
  return new;
end;
$$;

drop trigger if exists augment_start_fresh_backup_v62_trigger on public.app_backups;
create trigger augment_start_fresh_backup_v62_trigger
before insert or update of snapshot on public.app_backups
for each row execute function public.augment_start_fresh_backup_v62();

-- Core restore inserts documents before setting a backup to restored. Rebuild
-- the dependent cheque rows only after that core restore has completed.
create or replace function public.restore_start_fresh_backup_v62()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'restored'
     or not (new.snapshot ? 'cheque_payments') then
    return new;
  end if;

  delete from public.cheque_payments;
  insert into public.cheque_payments
  select * from jsonb_populate_recordset(
    null::public.cheque_payments,
    coalesce(new.snapshot -> 'cheque_payments', '[]'::jsonb)
  );
  return new;
end;
$$;

drop trigger if exists restore_start_fresh_backup_v62_trigger on public.app_backups;
create trigger restore_start_fresh_backup_v62_trigger
after update of status on public.app_backups
for each row execute function public.restore_start_fresh_backup_v62();

create or replace function public.admin_reset_business_data_v62(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_id uuid := public.current_pos_staff_id_v38();
  safety_backup_id uuid;
  removed_counts jsonb;
  active_admin_count integer;
begin
  if p_confirmation is distinct from 'RESET SHOP DATA' then
    raise exception 'Type RESET SHOP DATA exactly to continue';
  end if;

  if not exists (
    select 1 from public.staff s
    where s.id = admin_id and s.role = 'admin' and s.is_active
  ) then
    raise exception 'Unlock the POS with an active administrator PIN before starting fresh';
  end if;

  select count(*) into active_admin_count
  from public.staff s
  where s.role = 'admin' and s.is_active;

  if active_admin_count < 1 then
    raise exception 'Reset stopped because no active administrator account exists';
  end if;

  lock table
    public.assistant_messages,
    public.assistant_conversations,
    public.online_store_order_items,
    public.online_store_orders,
    public.cheque_payments,
    public.warranty_claim_events,
    public.warranty_claims,
    public.warranty_records,
    public.cashflow_entries,
    public.stock_movements,
    public.document_items,
    public.product_assembly_items,
    public.pos_drafts,
    public.documents,
    public.stock_balances,
    public.product_assemblies,
    public.store_product_content,
    public.products,
    public.store_category_content,
    public.categories,
    public.brands,
    public.customers,
    public.suppliers,
    public.document_sequences,
    public.accounting_journal_lines,
    public.accounting_journal_entries,
    public.accounting_opening_balances
  in access exclusive mode;

  safety_backup_id := public.create_app_backup_v31(
    'manual',
    'Automatic safety backup before Start Fresh reset'
  );

  removed_counts := jsonb_build_object(
    'products', (select count(*) from public.products),
    'categories', (select count(*) from public.categories),
    'customers', (select count(*) from public.customers),
    'suppliers', (select count(*) from public.suppliers),
    'documents', (select count(*) from public.documents),
    'document_items', (select count(*) from public.document_items),
    'cashflow_entries', (select count(*) from public.cashflow_entries),
    'online_orders', (select count(*) from public.online_store_orders),
    'cheque_payments', (select count(*) from public.cheque_payments),
    'warranties', (select count(*) from public.warranty_records),
    'assistant_conversations', (select count(*) from public.assistant_conversations)
  );

  perform set_config('shop_pos.restore_mode', 'on', true);

  -- Delete child records before their parents. In particular, cheque_payments
  -- did not exist when migration 050 was written and must be cleared first.
  delete from public.assistant_messages;
  delete from public.assistant_conversations;
  delete from public.online_store_order_items;
  delete from public.online_store_orders;
  delete from public.cheque_payments;
  delete from public.warranty_claim_events;
  delete from public.warranty_claims;
  delete from public.warranty_records;
  delete from public.cashflow_entries;
  delete from public.stock_movements;
  delete from public.document_items;
  delete from public.product_assembly_items;
  delete from public.pos_drafts;
  delete from public.documents;
  delete from public.stock_balances;
  delete from public.product_assemblies;
  delete from public.store_product_content;
  delete from public.products;
  delete from public.store_category_content;
  update public.categories set parent_id = null where parent_id is not null;
  delete from public.categories;
  delete from public.brands;
  delete from public.customers;
  delete from public.suppliers;
  delete from public.document_sequences;
  delete from public.accounting_journal_lines;
  delete from public.accounting_journal_entries;
  delete from public.accounting_opening_balances;

  perform setval('public.warranty_record_number_seq', 1, false);
  perform setval('public.warranty_claim_number_seq', 1, false);
  perform setval('public.online_store_order_number_v47_seq', 1, false);
  perform setval(pg_get_serial_sequence('public.assistant_messages', 'id'), 1, false);

  return jsonb_build_object(
    'safety_backup_id', safety_backup_id,
    'removed', removed_counts,
    'active_admins_preserved', active_admin_count,
    'reset_at', now()
  );
end;
$$;

revoke all on function public.augment_start_fresh_backup_v62() from public;
revoke all on function public.restore_start_fresh_backup_v62() from public;
revoke all on function public.admin_reset_business_data_v62(text) from public;
grant execute on function public.admin_reset_business_data_v62(text) to authenticated;

commit;

notify pgrst, 'reload schema';
