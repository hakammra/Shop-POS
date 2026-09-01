-- v57: Non-posting unconfirmed sales and customer-ready job documents.
-- Run once after 056_whatsapp_register_margin_cheques.sql.

begin;

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check check (document_type in (
  'invoice', 'unconfirmed_sale', 'quotation', 'purchase', 'stock_in_transit', 'stock_receiving',
  'refund', 'trade_in', 'job', 'customer_payment', 'supplier_payment', 'expense', 'other_income',
  'stock_adjustment', 'account_transfer', 'online_order', 'cod_order'
));

alter table public.documents
  add column if not exists unconfirmed_payments jsonb not null default '[]'::jsonb,
  add column if not exists unconfirmed_header jsonb not null default '{}'::jsonb,
  add column if not exists confirmed_at timestamptz;

create index if not exists documents_unconfirmed_sales_idx
  on public.documents(document_date desc, created_at desc)
  where document_type = 'unconfirmed_sale';

create or replace function public.next_document_no(p_document_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  account_code text;
  doc_year integer;
  short_year text;
  next_no integer;
begin
  account_code := case p_document_type
    when 'invoice' then '100'
    when 'sale' then '100'
    when 'unconfirmed_sale' then '105'
    when 'online_order' then '110'
    when 'cod_order' then '120'
    when 'purchase' then '200'
    when 'stock_in_transit' then '300'
    when 'quotation' then '400'
    when 'refund' then '500'
    when 'stock_adjustment' then '600'
    when 'trade_in' then '700'
    when 'job' then '750'
    when 'customer_payment' then '800'
    when 'supplier_payment' then '850'
    when 'expense' then '900'
    when 'other_income' then '950'
    when 'account_transfer' then '980'
    else '999'
  end;

  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');

  insert into public.document_sequences(document_type, document_year, last_no)
  values(p_document_type, doc_year, 1)
  on conflict(document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return short_year || account_code || lpad(next_no::text, 5, '0');
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

  if tg_op = 'INSERT' then new.created_by_staff_id := coalesce(new.created_by_staff_id, operator_id); end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

create or replace function public.save_unconfirmed_sale_v57(
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
  doc_id uuid := nullif(p_header ->> 'document_id', '')::uuid;
  doc_no text;
  existing_doc record;
  item jsonb;
  pay jsonb;
  pm record;
  first_pm_id uuid;
  gross numeric := 0;
  line_gross numeric;
  line_discount numeric;
  line_total numeric;
  cart_discount numeric := 0;
  final_total numeric;
  paid_in numeric := 0;
  paid_out numeric := 0;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Add at least one item'; end if;

  perform public.validate_pos_minimum_profit_v56(p_header, p_items);
  perform public.validate_cheque_payments_v56(p_payments);

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if nullif(item ->> 'product_id', '') is null or coalesce((item ->> 'qty')::numeric, 0) <= 0 then
      raise exception 'Unconfirmed sales require positive product quantities';
    end if;
    line_gross := round((item ->> 'qty')::numeric * coalesce((item ->> 'unit_price')::numeric, 0), 2);
    line_discount := case coalesce(item ->> 'discount_type', 'none')
      when 'percent' then round(line_gross * coalesce((item ->> 'discount_value')::numeric, 0) / 100, 2)
      when 'amount' then coalesce((item ->> 'discount_value')::numeric, 0)
      else 0 end;
    gross := gross + greatest(line_gross - line_discount, 0);
  end loop;

  cart_discount := case coalesce(p_header ->> 'cart_discount_type', 'amount')
    when 'percent' then round(gross * greatest(coalesce((p_header ->> 'cart_discount_value')::numeric, 0), 0) / 100, 2)
    else greatest(coalesce((p_header ->> 'cart_discount_value')::numeric, 0), 0) end;
  final_total := round(greatest(gross - cart_discount, 0), 2);
  if final_total <= 0 then raise exception 'Unconfirmed sale total must be greater than zero'; end if;

  for pay in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    select * into pm from public.payment_methods where id = nullif(pay ->> 'payment_method_id', '')::uuid and is_active;
    if not found then raise exception 'Payment method not found or inactive'; end if;
    if first_pm_id is null then first_pm_id := pm.id; end if;
    if coalesce(pm.is_paid_method, true) then
      if coalesce(pay ->> 'direction', 'in') = 'out' then paid_out := paid_out + coalesce((pay ->> 'amount')::numeric, 0);
      else paid_in := paid_in + coalesce((pay ->> 'amount')::numeric, 0); end if;
    end if;
  end loop;

  if doc_id is not null then
    select * into existing_doc from public.documents where id = doc_id for update;
    if not found or existing_doc.document_type <> 'unconfirmed_sale' then raise exception 'Unconfirmed sale not found'; end if;
    if existing_doc.status <> 'unconfirmed' then raise exception 'Only an unconfirmed sale can be edited'; end if;
    doc_no := existing_doc.document_no;
    delete from public.document_items where document_id = doc_id;
    update public.documents set
      customer_id = nullif(p_header ->> 'customer_id', '')::uuid,
      total_amount = final_total,
      paid_amount = greatest(paid_in - paid_out, 0),
      balance_amount = greatest(final_total - paid_in + paid_out, 0),
      payment_method_id = first_pm_id,
      document_date = coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
      notes = nullif(trim(coalesce(p_header ->> 'notes', '')), ''),
      unconfirmed_payments = coalesce(p_payments, '[]'::jsonb),
      unconfirmed_header = p_header - 'document_id',
      updated_at = now()
    where id = doc_id;
  else
    doc_no := coalesce(nullif(trim(p_header ->> 'document_no'), ''), public.next_document_no('unconfirmed_sale'));
    insert into public.documents(
      document_no, document_type, status, customer_id, total_amount, paid_amount, balance_amount,
      currency, payment_method_id, document_date, notes, unconfirmed_payments, unconfirmed_header
    ) values (
      doc_no, 'unconfirmed_sale', 'unconfirmed', nullif(p_header ->> 'customer_id', '')::uuid,
      final_total, greatest(paid_in - paid_out, 0), greatest(final_total - paid_in + paid_out, 0),
      'LKR', first_pm_id, coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
      nullif(trim(coalesce(p_header ->> 'notes', '')), ''), coalesce(p_payments, '[]'::jsonb), p_header - 'document_id'
    ) returning id into doc_id;
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    line_gross := round((item ->> 'qty')::numeric * coalesce((item ->> 'unit_price')::numeric, 0), 2);
    line_discount := case coalesce(item ->> 'discount_type', 'none')
      when 'percent' then round(line_gross * coalesce((item ->> 'discount_value')::numeric, 0) / 100, 2)
      when 'amount' then coalesce((item ->> 'discount_value')::numeric, 0)
      else 0 end;
    line_total := round(greatest(line_gross - line_discount, 0), 2);
    insert into public.document_items(
      document_id, product_id, item_code, description, qty, unit_price, unit_cost,
      discount_type, discount_value, line_total
    ) values (
      doc_id, (item ->> 'product_id')::uuid, item ->> 'item_code', coalesce(nullif(item ->> 'description', ''), 'Item'),
      (item ->> 'qty')::numeric, coalesce((item ->> 'unit_price')::numeric, 0), coalesce((item ->> 'unit_cost')::numeric, 0),
      coalesce(nullif(item ->> 'discount_type', ''), 'none'), coalesce((item ->> 'discount_value')::numeric, 0), line_total
    );
  end loop;

  return jsonb_build_object(
    'id', doc_id, 'document_no', doc_no, 'document_type', 'unconfirmed_sale', 'status', 'unconfirmed',
    'total_amount', final_total, 'paid_amount', greatest(paid_in - paid_out, 0),
    'balance_amount', greatest(final_total - paid_in + paid_out, 0)
  );
end;
$$;

create or replace function public.confirm_unconfirmed_sale_v57(
  p_source_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare admin_id uuid; source_doc record; result jsonb;
begin
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff s where s.id = admin_id and s.role = 'admin' and s.is_active) then
    raise exception 'An active administrator must confirm this sale';
  end if;
  select * into source_doc from public.documents where id = p_source_document_id for update;
  if not found or source_doc.document_type <> 'unconfirmed_sale' then raise exception 'Unconfirmed sale not found'; end if;
  if source_doc.status <> 'unconfirmed' then raise exception 'This sale has already been confirmed or closed'; end if;

  result := public.save_pos_invoice_v56(p_header - 'document_id', p_items, p_payments);
  update public.documents set status = 'converted', linked_document_id = (result ->> 'id')::uuid,
    confirmed_at = now(), updated_at = now() where id = source_doc.id;
  return result || jsonb_build_object('source_document_id', source_doc.id, 'source_document_no', source_doc.document_no);
end;
$$;

create or replace function public.delete_unconfirmed_sale_v57(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare doc record;
begin
  if not public.has_pos_permission_v38('delete_documents') then raise exception 'Document deletion permission required'; end if;
  select * into doc from public.documents where id = p_document_id for update;
  if not found or doc.document_type <> 'unconfirmed_sale' then raise exception 'Unconfirmed sale not found'; end if;
  if doc.status = 'converted' then raise exception 'A converted sale must be retained as an audit record'; end if;
  delete from public.documents where id = p_document_id;
  return jsonb_build_object('deleted', true, 'document_no', doc.document_no);
end;
$$;

revoke all on function public.save_unconfirmed_sale_v57(jsonb, jsonb, jsonb) from public;
revoke all on function public.confirm_unconfirmed_sale_v57(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.delete_unconfirmed_sale_v57(uuid) from public;
grant execute on function public.save_unconfirmed_sale_v57(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.confirm_unconfirmed_sale_v57(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.delete_unconfirmed_sale_v57(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
