-- v67: Permission-controlled correction of finalized POS sales invoices.
-- Run once after 066_delivery_orders_prepaid.sql.

begin;

create or replace function public.replace_pos_invoice_v67(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  old_doc public.documents%rowtype;
  new_doc public.documents%rowtype;
  old_item record;
  old_cash_in numeric := 0;
  old_cash_out numeric := 0;
  old_outstanding_delta numeric := 0;
  old_flow_time timestamptz;
  old_register_shift_id uuid;
  original_no text;
  temporary_no text;
  new_id uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  if not public.has_pos_permission_v38('edit_sales_documents') then raise exception 'Edit sales documents permission required'; end if;

  select * into old_doc from public.documents where id = p_document_id for update;
  if not found or old_doc.document_type <> 'invoice' then raise exception 'Sales invoice not found'; end if;
  if lower(coalesce(old_doc.status, '')) in ('cancelled', 'canceled', 'void', 'voided', 'deleted') then
    raise exception 'A cancelled or void invoice cannot be edited';
  end if;
  if exists (
    select 1
    from public.document_items returned_item
    join public.document_items original_item on original_item.id = returned_item.source_document_item_id
    where original_item.document_id = p_document_id
  ) then
    raise exception 'This invoice already has a linked return. Use a new return or correction document instead of editing it';
  end if;
  if to_regclass('public.warranty_records') is not null and exists (
    select 1 from public.warranty_records where sale_document_id = p_document_id
  ) then
    raise exception 'This invoice has registered warranty records and cannot be edited. Use the return or warranty workflow instead';
  end if;

  original_no := old_doc.document_no;
  temporary_no := left(original_no, 120) || '-EDIT-' || left(replace(p_document_id::text, '-', ''), 8);

  select
    coalesce(sum(case when cf.entry_type = 'cash_in' then cf.amount else 0 end), 0),
    coalesce(sum(case when cf.entry_type = 'cash_out' then cf.amount else 0 end), 0),
    min(cf.created_at),
    (array_agg(cf.register_shift_id order by cf.created_at) filter (where cf.register_shift_id is not null))[1]
  into old_cash_in, old_cash_out, old_flow_time, old_register_shift_id
  from public.cashflow_entries cf
  where cf.document_id = p_document_id;

  old_outstanding_delta := round(coalesce(old_doc.total_amount, 0) - old_cash_in + old_cash_out, 2);
  if old_doc.customer_id is not null and old_outstanding_delta <> 0 then
    perform public.apply_customer_outstanding_delta(old_doc.customer_id, -1 * old_outstanding_delta);
  end if;

  for old_item in
    select di.*, coalesce(p.track_inventory, true) as track_inventory
    from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id
    order by di.created_at, di.id
  loop
    if not old_item.track_inventory then continue; end if;
    insert into public.stock_balances(product_id) values(old_item.product_id) on conflict(product_id) do nothing;
    perform 1 from public.stock_balances where product_id = old_item.product_id for update;

    if old_item.qty > 0 then
      update public.stock_balances
      set sellable_qty = coalesce(sellable_qty, 0) + old_item.qty, updated_at = now()
      where product_id = old_item.product_id;
    elsif coalesce(old_item.return_condition, 'sellable') = 'warranty_damaged' then
      if (select coalesce(damaged_qty, 0) from public.stock_balances where product_id = old_item.product_id) < abs(old_item.qty) then
        raise exception 'Cannot edit invoice: damaged stock for % has already been moved or adjusted', coalesce(old_item.item_code, old_item.description);
      end if;
      update public.stock_balances
      set damaged_qty = coalesce(damaged_qty, 0) - abs(old_item.qty), updated_at = now()
      where product_id = old_item.product_id;
    else
      if (select coalesce(sellable_qty, 0) from public.stock_balances where product_id = old_item.product_id) < abs(old_item.qty) then
        raise exception 'Cannot edit invoice: returned stock for % has already been sold or adjusted', coalesce(old_item.item_code, old_item.description);
      end if;
      update public.stock_balances
      set sellable_qty = coalesce(sellable_qty, 0) - abs(old_item.qty), updated_at = now()
      where product_id = old_item.product_id;
    end if;
  end loop;

  delete from public.cheque_payments where document_id = p_document_id;
  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.stock_movements where document_id = p_document_id;
  delete from public.document_items where document_id = p_document_id;

  update public.documents set document_no = temporary_no, updated_at = now() where id = p_document_id;

  result := public.save_pos_invoice_v56(
    coalesce(p_header, '{}'::jsonb) || jsonb_build_object('document_no', original_no),
    coalesce(p_items, '[]'::jsonb),
    coalesce(p_payments, '[]'::jsonb)
  );
  new_id := nullif(result ->> 'id', '')::uuid;
  if new_id is null then raise exception 'The corrected invoice was not created'; end if;
  select * into new_doc from public.documents where id = new_id for update;

  update public.document_items set document_id = p_document_id where document_id = new_id;
  update public.stock_movements set document_id = p_document_id where document_id = new_id;
  update public.cashflow_entries
  set document_id = p_document_id,
      created_at = coalesce(old_flow_time, old_doc.created_at),
      register_shift_id = old_register_shift_id
  where document_id = new_id;
  update public.cheque_payments set document_id = p_document_id where document_id = new_id;

  perform set_config('shop_pos.sales_edit_cleanup_id', new_id::text, true);
  delete from public.documents where id = new_id;
  perform set_config('shop_pos.sales_edit_cleanup_id', '', true);

  update public.documents
  set document_no = original_no,
      customer_id = new_doc.customer_id,
      status = new_doc.status,
      total_amount = new_doc.total_amount,
      paid_amount = new_doc.paid_amount,
      balance_amount = new_doc.balance_amount,
      currency = new_doc.currency,
      payment_method_id = new_doc.payment_method_id,
      document_date = old_doc.document_date,
      notes = new_doc.notes,
      updated_at = now()
  where id = p_document_id;

  return result || jsonb_build_object(
    'id', p_document_id,
    'document_no', original_no,
    'original_created_by_staff_id', old_doc.created_by_staff_id,
    'edited_by_staff_id', public.current_pos_staff_id_v38()
  );
end;
$$;

create or replace function public.audit_document_operator_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare operator_id uuid;
declare needed_permission text;
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  operator_id := public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;

  if tg_op = 'DELETE' then
    if old.document_type = 'invoice'
       and current_setting('shop_pos.sales_edit_cleanup_id', true) = old.id::text
       and public.has_pos_permission_v38('edit_sales_documents') then
      return old;
    end if;
    if not public.has_pos_permission_v38('delete_documents') then raise exception 'You do not have permission to delete documents'; end if;
    return old;
  end if;

  needed_permission := case new.document_type
    when 'invoice' then 'pos_sales'
    when 'unconfirmed_sale' then 'pos_sales'
    when 'quotation' then 'create_quotes'
    when 'cod_order' then 'manage_cod_orders'
    when 'online_order' then 'manage_online_orders'
    when 'job' then 'manage_jobs'
    when 'purchase' then 'manage_inventory_documents'
    when 'stock_in_transit' then 'manage_inventory_documents'
    when 'stock_receiving' then 'manage_inventory_documents'
    when 'stock_adjustment' then 'manage_inventory_documents'
    when 'trade_in' then 'manage_inventory_documents'
    when 'customer_payment' then 'manage_parties'
    when 'supplier_payment' then 'manage_parties'
    when 'expense' then 'manage_cashflow'
    when 'other_income' then 'manage_cashflow'
    when 'account_transfer' then 'manage_cashflow'
    when 'refund' then 'process_returns'
    else 'view_documents'
  end;
  if not public.has_pos_permission_v38(needed_permission) then raise exception 'The active user does not have permission for this document action'; end if;

  if tg_op = 'INSERT' then
    new.created_by_staff_id := operator_id;
    if new.document_type = 'cod_order' then new.order_taken_by := operator_id; end if;
  else
    new.created_by_staff_id := old.created_by_staff_id;
    if new.document_type = 'cod_order' then
      new.order_taken_by := coalesce(old.order_taken_by, old.created_by_staff_id, operator_id);
    end if;
  end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

revoke all on function public.replace_pos_invoice_v67(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.replace_pos_invoice_v67(uuid, jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
