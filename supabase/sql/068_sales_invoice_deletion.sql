-- v68: Permission-controlled deletion of finalized sales invoices.
-- Run once after 067_sales_invoice_corrections.sql.

begin;

create or replace function public.resync_closed_register_v68(p_register_shift_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_register_shift_id is null then return; end if;
  update public.register_shifts rs
  set expected_cash = round(rs.opening_cash + coalesce((
        select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
        from public.cashflow_entries cf
        join public.payment_methods pm on pm.id = cf.payment_method_id
        where cf.register_shift_id = rs.id and pm.account_kind = 'cash'
      ), 0), 2),
      variance = case when rs.counted_cash is null then null else round(rs.counted_cash - (rs.opening_cash + coalesce((
        select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
        from public.cashflow_entries cf
        join public.payment_methods pm on pm.id = cf.payment_method_id
        where cf.register_shift_id = rs.id and pm.account_kind = 'cash'
      ), 0)), 2) end,
      updated_at = now()
  where rs.id = p_register_shift_id and rs.status = 'closed';
end;
$$;

create or replace function public.cashflow_resync_closed_register_v68()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.register_shift_id is not null then
    perform public.resync_closed_register_v68(old.register_shift_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.register_shift_id is not null
     and (tg_op <> 'UPDATE' or new.register_shift_id is distinct from old.register_shift_id) then
    perform public.resync_closed_register_v68(new.register_shift_id);
  end if;
  return null;
end;
$$;

drop trigger if exists cashflow_resync_closed_register_v68_trigger on public.cashflow_entries;
create trigger cashflow_resync_closed_register_v68_trigger
after insert or update or delete on public.cashflow_entries
for each row execute function public.cashflow_resync_closed_register_v68();

create or replace function public.delete_pos_invoice_v68(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_doc public.documents%rowtype;
  sale_item record;
  cash_in_total numeric := 0;
  cash_out_total numeric := 0;
  outstanding_delta numeric := 0;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Delete finalized sales documents permission required';
  end if;

  select * into sale_doc from public.documents where id = p_document_id for update;
  if not found or sale_doc.document_type <> 'invoice' then raise exception 'Sales invoice not found'; end if;

  if exists (
    select 1
    from public.document_items returned_item
    join public.document_items original_item on original_item.id = returned_item.source_document_item_id
    where original_item.document_id = p_document_id
  ) then
    raise exception 'This invoice already has a linked return and cannot be deleted';
  end if;
  if exists (select 1 from public.warranty_records where sale_document_id = p_document_id) then
    raise exception 'This invoice has registered warranty records and cannot be deleted';
  end if;
  if exists (select 1 from public.documents where linked_document_id = p_document_id) then
    raise exception 'Another document is linked to this invoice, so it cannot be deleted';
  end if;

  select
    coalesce(sum(case when cf.entry_type = 'cash_in' then cf.amount else 0 end), 0),
    coalesce(sum(case when cf.entry_type = 'cash_out' then cf.amount else 0 end), 0)
  into cash_in_total, cash_out_total
  from public.cashflow_entries cf
  where cf.document_id = p_document_id;

  outstanding_delta := round(coalesce(sale_doc.total_amount, 0) - cash_in_total + cash_out_total, 2);
  if sale_doc.customer_id is not null and outstanding_delta <> 0 then
    perform public.apply_customer_outstanding_delta(sale_doc.customer_id, -1 * outstanding_delta);
  end if;

  for sale_item in
    select di.*, coalesce(p.track_inventory, true) as track_inventory
    from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id
    order by di.created_at, di.id
  loop
    if not sale_item.track_inventory then continue; end if;
    insert into public.stock_balances(product_id) values(sale_item.product_id) on conflict(product_id) do nothing;
    perform 1 from public.stock_balances where product_id = sale_item.product_id for update;

    if sale_item.qty > 0 then
      update public.stock_balances
      set sellable_qty = coalesce(sellable_qty, 0) + sale_item.qty, updated_at = now()
      where product_id = sale_item.product_id;
    elsif coalesce(sale_item.return_condition, 'sellable') = 'warranty_damaged' then
      if (select coalesce(damaged_qty, 0) from public.stock_balances where product_id = sale_item.product_id) < abs(sale_item.qty) then
        raise exception 'Cannot delete invoice: damaged stock for % has already been moved or adjusted', coalesce(sale_item.item_code, sale_item.description);
      end if;
      update public.stock_balances
      set damaged_qty = coalesce(damaged_qty, 0) - abs(sale_item.qty), updated_at = now()
      where product_id = sale_item.product_id;
    else
      if (select coalesce(sellable_qty, 0) from public.stock_balances where product_id = sale_item.product_id) < abs(sale_item.qty) then
        raise exception 'Cannot delete invoice: returned stock for % has already been sold or adjusted', coalesce(sale_item.item_code, sale_item.description);
      end if;
      update public.stock_balances
      set sellable_qty = coalesce(sellable_qty, 0) - abs(sale_item.qty), updated_at = now()
      where product_id = sale_item.product_id;
    end if;
  end loop;

  delete from public.cheque_payments where document_id = p_document_id;
  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.stock_movements where document_id = p_document_id;
  delete from public.documents where id = p_document_id;

  return jsonb_build_object('deleted', true, 'document_no', sale_doc.document_no);
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
    if old.document_type = 'invoice' then
      if current_setting('shop_pos.sales_edit_cleanup_id', true) = old.id::text
         and public.has_pos_permission_v38('edit_sales_documents') then
        return old;
      end if;
      if not public.has_pos_permission_v38('delete_sales_documents') then
        raise exception 'Delete finalized sales documents permission required';
      end if;
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
    if new.document_type = 'cod_order' then new.order_taken_by := coalesce(old.order_taken_by, old.created_by_staff_id, operator_id); end if;
  end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

revoke all on function public.resync_closed_register_v68(uuid) from public;
revoke all on function public.delete_pos_invoice_v68(uuid) from public;
grant execute on function public.delete_pos_invoice_v68(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
