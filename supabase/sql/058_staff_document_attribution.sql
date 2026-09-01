-- v58: Reliable active-staff attribution for every document and COD commissions.
-- Run once after 057_unconfirmed_sales_job_documents.sql.

begin;

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
    -- Creator/commission ownership never changes when another staff member edits.
    new.created_by_staff_id := old.created_by_staff_id;
    if new.document_type = 'cod_order' then
      new.order_taken_by := coalesce(old.order_taken_by, old.created_by_staff_id, operator_id);
    end if;
  end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

-- Preserve the best available attribution for COD orders created before v58.
update public.documents
set created_by_staff_id = coalesce(created_by_staff_id, order_taken_by),
    order_taken_by = coalesce(order_taken_by, created_by_staff_id)
where document_type = 'cod_order'
  and (created_by_staff_id is null or order_taken_by is null);

notify pgrst, 'reload schema';
commit;
