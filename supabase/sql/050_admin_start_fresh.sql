-- v50: Admin-only Start Fresh reset with an automatic, restorable safety backup.
-- Run once after 049_store_category_sync.sql.

begin;

-- Extend the existing logical backup so a reset can also recover newer
-- storefront, online-order and assistant-history records.
create or replace function public.augment_start_fresh_backup_v50()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object(
    'store_product_content', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at, x.product_id) from public.store_product_content x), '[]'::jsonb),
    'store_category_content', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at, x.category_id) from public.store_category_content x), '[]'::jsonb),
    'online_store_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.online_store_orders x), '[]'::jsonb),
    'online_store_order_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.online_store_order_items x), '[]'::jsonb),
    'assistant_conversations', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.assistant_conversations x), '[]'::jsonb),
    'assistant_messages', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.assistant_messages x), '[]'::jsonb),
    'v50_sequences', jsonb_build_object(
      'warranty_record', (select jsonb_build_object('last_value', x.last_value, 'is_called', x.is_called) from public.warranty_record_number_seq x),
      'warranty_claim', (select jsonb_build_object('last_value', x.last_value, 'is_called', x.is_called) from public.warranty_claim_number_seq x),
      'online_order', (select jsonb_build_object('last_value', x.last_value, 'is_called', x.is_called) from public.online_store_order_number_v47_seq x)
    )
  );
  new.row_counts := coalesce(new.row_counts, '{}'::jsonb) || jsonb_build_object(
    'online_orders', (select count(*) from public.online_store_orders),
    'assistant_conversations', (select count(*) from public.assistant_conversations),
    'store_product_content', (select count(*) from public.store_product_content)
  );
  new.schema_version := greatest(coalesce(new.schema_version, 31), 50);
  new.snapshot_size_bytes := pg_column_size(new.snapshot);
  return new;
end;
$$;

drop trigger if exists augment_start_fresh_backup_v50_trigger on public.app_backups;
create trigger augment_start_fresh_backup_v50_trigger
before insert or update of snapshot on public.app_backups
for each row execute function public.augment_start_fresh_backup_v50();

-- The v31 restore rebuilds the core tables first and then marks the selected
-- backup as restored. This dependent trigger restores the v50 records after
-- their products, categories and staff rows exist again.
create or replace function public.restore_start_fresh_backup_v50()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sequence_data jsonb;
begin
  if new.status <> 'restored'
     or not (new.snapshot ? 'store_product_content') then
    return new;
  end if;

  delete from public.assistant_messages;
  delete from public.assistant_conversations;
  delete from public.online_store_order_items;
  delete from public.online_store_orders;
  delete from public.store_product_content;
  delete from public.store_category_content;

  insert into public.store_category_content
  select * from jsonb_populate_recordset(null::public.store_category_content, coalesce(new.snapshot -> 'store_category_content', '[]'::jsonb));
  insert into public.store_product_content
  select * from jsonb_populate_recordset(null::public.store_product_content, coalesce(new.snapshot -> 'store_product_content', '[]'::jsonb));
  insert into public.online_store_orders
  select * from jsonb_populate_recordset(null::public.online_store_orders, coalesce(new.snapshot -> 'online_store_orders', '[]'::jsonb));
  insert into public.online_store_order_items
  select * from jsonb_populate_recordset(null::public.online_store_order_items, coalesce(new.snapshot -> 'online_store_order_items', '[]'::jsonb));
  insert into public.assistant_conversations
  select * from jsonb_populate_recordset(null::public.assistant_conversations, coalesce(new.snapshot -> 'assistant_conversations', '[]'::jsonb));
  insert into public.assistant_messages
  overriding system value
  select * from jsonb_populate_recordset(null::public.assistant_messages, coalesce(new.snapshot -> 'assistant_messages', '[]'::jsonb));

  if exists (select 1 from public.assistant_messages) then
    perform setval(pg_get_serial_sequence('public.assistant_messages', 'id'), (select max(id) from public.assistant_messages), true);
  else
    perform setval(pg_get_serial_sequence('public.assistant_messages', 'id'), 1, false);
  end if;

  sequence_data := new.snapshot -> 'v50_sequences';
  if sequence_data is not null then
    perform setval('public.warranty_record_number_seq', greatest(coalesce((sequence_data #>> '{warranty_record,last_value}')::bigint, 1), 1), coalesce((sequence_data #>> '{warranty_record,is_called}')::boolean, false));
    perform setval('public.warranty_claim_number_seq', greatest(coalesce((sequence_data #>> '{warranty_claim,last_value}')::bigint, 1), 1), coalesce((sequence_data #>> '{warranty_claim,is_called}')::boolean, false));
    perform setval('public.online_store_order_number_v47_seq', greatest(coalesce((sequence_data #>> '{online_order,last_value}')::bigint, 1), 1), coalesce((sequence_data #>> '{online_order,is_called}')::boolean, false));
  end if;

  return new;
end;
$$;

drop trigger if exists restore_start_fresh_backup_v50_trigger on public.app_backups;
create trigger restore_start_fresh_backup_v50_trigger
after update of status on public.app_backups
for each row execute function public.restore_start_fresh_backup_v50();

create or replace function public.admin_reset_business_data_v50(p_confirmation text)
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
    raise exception 'An active administrator PIN session is required';
  end if;

  select count(*) into active_admin_count
  from public.staff s
  where s.role = 'admin' and s.is_active;

  if active_admin_count < 1 then
    raise exception 'Reset stopped because no active administrator account exists';
  end if;

  -- Keep the snapshot and deletion set consistent if another trusted device is
  -- open. Other writes wait briefly until this transaction has completed.
  lock table
    public.assistant_messages,
    public.assistant_conversations,
    public.online_store_order_items,
    public.online_store_orders,
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
    public.accounting_journal_entries,
    public.accounting_opening_balances
  in access exclusive mode;

  -- This is created before any deletion. A failure anywhere below rolls back
  -- both the deletion and this backup as one database transaction.
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
    'warranties', (select count(*) from public.warranty_records),
    'assistant_conversations', (select count(*) from public.assistant_conversations)
  );

  perform set_config('shop_pos.restore_mode', 'on', true);

  delete from public.assistant_messages;
  delete from public.assistant_conversations;
  delete from public.online_store_order_items;
  delete from public.online_store_orders;
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
  delete from public.accounting_journal_entries;
  delete from public.accounting_opening_balances;

  perform setval('public.warranty_record_number_seq', 1, false);
  perform setval('public.warranty_claim_number_seq', 1, false);
  perform setval('public.online_store_order_number_v47_seq', 1, false);
  perform setval(pg_get_serial_sequence('public.assistant_messages', 'id'), 1, false);

  select count(*) into active_admin_count
  from public.staff s
  where s.role = 'admin' and s.is_active;

  if active_admin_count < 1 then
    raise exception 'Reset rolled back because it would leave no active administrator';
  end if;

  return jsonb_build_object(
    'safety_backup_id', safety_backup_id,
    'removed', removed_counts,
    'active_admins_preserved', active_admin_count,
    'reset_at', now()
  );
end;
$$;

revoke all on function public.augment_start_fresh_backup_v50() from public;
revoke all on function public.restore_start_fresh_backup_v50() from public;
revoke all on function public.admin_reset_business_data_v50(text) from public;
grant execute on function public.admin_reset_business_data_v50(text) to authenticated;

commit;

notify pgrst, 'reload schema';
