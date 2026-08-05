-- v24: Save-time document numbering + COD order workflow.
-- Run once after 023.
-- New numbers are allocated inside the same transaction that saves the document,
-- so closing an unsaved form no longer consumes a number.

create extension if not exists pgcrypto;

-- Keep the document type constraint aligned with every type used by the app.
alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents
  add constraint documents_document_type_check check (document_type in (
    'invoice',
    'quotation',
    'purchase',
    'stock_in_transit',
    'stock_receiving',
    'refund',
    'trade_in',
    'job',
    'customer_payment',
    'supplier_payment',
    'expense',
    'stock_adjustment',
    'online_order',
    'cod_order'
  ));

alter table public.documents
  add column if not exists order_source text,
  add column if not exists order_taken_by uuid references public.staff(id) on delete set null,
  add column if not exists recipient_name text,
  add column if not exists delivery_phone text,
  add column if not exists delivery_address text,
  add column if not exists delivery_service text,
  add column if not exists tracking_number text,
  add column if not exists delivery_charge numeric(12,2) not null default 0,
  add column if not exists delivery_charge_paid numeric(12,2) not null default 0,
  add column if not exists delivery_fee_mode text not null default 'deduct_on_settlement',
  add column if not exists cod_collect_amount numeric(12,2) not null default 0,
  add column if not exists cod_received_amount numeric(12,2) not null default 0,
  add column if not exists cod_stock_reserved boolean not null default false,
  add column if not exists dispatched_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists settled_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists return_reason text;

alter table public.documents drop constraint if exists documents_delivery_fee_mode_check;
alter table public.documents
  add constraint documents_delivery_fee_mode_check
  check (delivery_fee_mode in ('deduct_on_settlement', 'paid_on_handover'));

create index if not exists documents_cod_status_idx
  on public.documents(document_type, status, document_date desc);
create index if not exists documents_tracking_number_idx
  on public.documents(tracking_number)
  where tracking_number is not null;

-- A sale or stock correction must never consume units already reserved for an
-- active COD order. This also closes the small stale-cart race that UI-only
-- available-stock checks cannot prevent.
create or replace function public.protect_reserved_stock_v24()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.sellable_qty, 0) < coalesce(new.reserved_qty, 0) then
    raise exception 'Stock change would consume reserved units for product %', new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_reserved_stock_v24 on public.stock_balances;
create trigger protect_reserved_stock_v24
before update of sellable_qty, reserved_qty on public.stock_balances
for each row execute function public.protect_reserved_stock_v24();

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
    when 'cod_order' then '120'
    when 'online_order' then '110'
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
    else '999'
  end;

  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');

  insert into public.document_sequences (document_type, document_year, last_no)
  values (p_document_type, doc_year, 1)
  on conflict (document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return short_year || account_code || lpad(next_no::text, 5, '0');
end;
$$;

grant execute on function public.next_document_no(text) to authenticated;

-- Quotation saving is now transactional. If validation or insertion fails, the
-- document number increment rolls back with the rest of the transaction.
create or replace function public.save_quotation_v24(
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  doc_no text;
  item record;
  total numeric(12,2) := 0;
begin
  doc_no := nullif(trim(coalesce(p_header ->> 'document_no', '')), '');
  if doc_no is null then
    doc_no := public.next_document_no('quotation');
  end if;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_price numeric,
      unit_cost numeric,
      discount_type text,
      discount_value numeric,
      line_total numeric
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every quotation item must have a product and quantity greater than zero';
    end if;
    total := total + round(coalesce(item.line_total, item.qty * item.unit_price, 0), 2);
  end loop;

  if total <= 0 then
    raise exception 'Quotation total must be greater than zero';
  end if;

  insert into public.documents (
    document_no, external_document_no, document_type, status, customer_id,
    total_amount, paid_amount, balance_amount, currency, document_date, notes
  ) values (
    doc_no,
    nullif(trim(coalesce(p_header ->> 'external_document_no', '')), ''),
    'quotation',
    'draft',
    nullif(p_header ->> 'customer_id', '')::uuid,
    total,
    0,
    total,
    'LKR',
    coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
    nullif(trim(coalesce(p_header ->> 'notes', '')), '')
  ) returning id into doc_id;

  insert into public.document_items (
    document_id, product_id, item_code, description, qty, unit_price, unit_cost,
    discount_type, discount_value, line_total
  )
  select
    doc_id,
    x.product_id,
    x.item_code,
    x.description,
    x.qty,
    coalesce(x.unit_price, 0),
    coalesce(x.unit_cost, 0),
    coalesce(nullif(x.discount_type, ''), 'none'),
    coalesce(x.discount_value, 0),
    round(coalesce(x.line_total, x.qty * x.unit_price, 0), 2)
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
    product_id uuid,
    item_code text,
    description text,
    qty numeric,
    unit_price numeric,
    unit_cost numeric,
    discount_type text,
    discount_value numeric,
    line_total numeric
  );

  return jsonb_build_object('id', doc_id, 'document_no', doc_no, 'total_amount', total);
end;
$$;

grant execute on function public.save_quotation_v24(jsonb, jsonb) to authenticated;

create or replace function public.release_cod_reservation_v24(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if not coalesce(doc.cod_stock_reserved, false) then return; end if;

  for item in select * from public.document_items where document_id = p_document_id loop
    insert into public.stock_balances (product_id) values (item.product_id)
    on conflict (product_id) do nothing;

    update public.stock_balances
    set reserved_qty = greatest(coalesce(reserved_qty, 0) - item.qty, 0),
        updated_at = now()
    where product_id = item.product_id;

    insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
    values (item.product_id, p_document_id, 'release_reserve', -1 * item.qty, item.unit_cost, 'COD order reservation released');
  end loop;

  update public.documents
  set cod_stock_reserved = false, updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.apply_cod_reservation_v24(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  available numeric(12,3);
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if coalesce(doc.cod_stock_reserved, false) then return; end if;

  for item in select * from public.document_items where document_id = p_document_id loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every COD item must have a product and quantity greater than zero';
    end if;

    insert into public.stock_balances (product_id) values (item.product_id)
    on conflict (product_id) do nothing;

    select coalesce(sellable_qty, 0) - coalesce(reserved_qty, 0)
    into available
    from public.stock_balances
    where product_id = item.product_id
    for update;

    if available < item.qty then
      raise exception 'Not enough available stock for %. Available %, requested %', coalesce(item.item_code, item.description), available, item.qty;
    end if;

    update public.stock_balances
    set reserved_qty = coalesce(reserved_qty, 0) + item.qty,
        updated_at = now()
    where product_id = item.product_id;

    insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
    values (item.product_id, p_document_id, 'reserve', item.qty, item.unit_cost, 'Reserved for COD order');
  end loop;

  update public.documents
  set cod_stock_reserved = true, updated_at = now()
  where id = p_document_id;
end;
$$;

grant execute on function public.release_cod_reservation_v24(uuid) to authenticated;
grant execute on function public.apply_cod_reservation_v24(uuid) to authenticated;

create or replace function public.save_cod_order_v24(
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  doc_no text;
  item record;
  total numeric(12,2) := 0;
  collect_amount numeric(12,2);
begin
  doc_no := nullif(trim(coalesce(p_header ->> 'document_no', '')), '');
  if doc_no is null then doc_no := public.next_document_no('cod_order'); end if;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid, item_code text, description text, qty numeric,
      unit_price numeric, unit_cost numeric, discount_type text,
      discount_value numeric, line_total numeric
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every COD item must have a product and quantity greater than zero';
    end if;
    total := total + round(coalesce(item.line_total, item.qty * item.unit_price, 0), 2);
  end loop;

  if total <= 0 then raise exception 'COD order total must be greater than zero'; end if;
  if nullif(trim(coalesce(p_header ->> 'recipient_name', '')), '') is null then raise exception 'Customer/recipient name is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_phone', '')), '') is null then raise exception 'Customer contact number is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_address', '')), '') is null then raise exception 'Delivery address is required'; end if;

  collect_amount := coalesce(nullif(p_header ->> 'cod_collect_amount', '')::numeric, total);

  insert into public.documents (
    document_no, document_type, status, customer_id, total_amount, paid_amount,
    balance_amount, currency, document_date, notes, order_source, order_taken_by,
    recipient_name, delivery_phone, delivery_address, delivery_service,
    tracking_number, delivery_charge, delivery_fee_mode, cod_collect_amount
  ) values (
    doc_no, 'cod_order', 'awaiting_packing', nullif(p_header ->> 'customer_id', '')::uuid,
    total, 0, total, 'LKR',
    coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
    nullif(trim(coalesce(p_header ->> 'notes', '')), ''),
    nullif(trim(coalesce(p_header ->> 'order_source', '')), ''),
    nullif(p_header ->> 'order_taken_by', '')::uuid,
    trim(p_header ->> 'recipient_name'), trim(p_header ->> 'delivery_phone'),
    trim(p_header ->> 'delivery_address'),
    nullif(trim(coalesce(p_header ->> 'delivery_service', '')), ''),
    nullif(trim(coalesce(p_header ->> 'tracking_number', '')), ''),
    greatest(coalesce(nullif(p_header ->> 'delivery_charge', '')::numeric, 0), 0),
    coalesce(nullif(p_header ->> 'delivery_fee_mode', ''), 'deduct_on_settlement'),
    collect_amount
  ) returning id into doc_id;

  insert into public.document_items (
    document_id, product_id, item_code, description, qty, unit_price, unit_cost,
    discount_type, discount_value, line_total
  )
  select doc_id, x.product_id, x.item_code, x.description, x.qty,
    coalesce(x.unit_price, 0), coalesce(x.unit_cost, 0),
    coalesce(nullif(x.discount_type, ''), 'none'), coalesce(x.discount_value, 0),
    round(coalesce(x.line_total, x.qty * x.unit_price, 0), 2)
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
    product_id uuid, item_code text, description text, qty numeric,
    unit_price numeric, unit_cost numeric, discount_type text,
    discount_value numeric, line_total numeric
  );

  perform public.apply_cod_reservation_v24(doc_id);
  return jsonb_build_object('id', doc_id, 'document_no', doc_no, 'total_amount', total);
end;
$$;

grant execute on function public.save_cod_order_v24(jsonb, jsonb) to authenticated;

create or replace function public.replace_cod_order_v24(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  total numeric(12,2) := 0;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if doc.status in ('converted', 'returned', 'cancelled') then
    raise exception 'Completed, returned, or cancelled COD orders cannot be edited';
  end if;

  perform public.release_cod_reservation_v24(p_document_id);
  delete from public.document_items where document_id = p_document_id;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid, item_code text, description text, qty numeric,
      unit_price numeric, unit_cost numeric, discount_type text,
      discount_value numeric, line_total numeric
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every COD item must have a product and quantity greater than zero';
    end if;
    insert into public.document_items (
      document_id, product_id, item_code, description, qty, unit_price, unit_cost,
      discount_type, discount_value, line_total
    ) values (
      p_document_id, item.product_id, item.item_code, item.description, item.qty,
      coalesce(item.unit_price, 0), coalesce(item.unit_cost, 0),
      coalesce(nullif(item.discount_type, ''), 'none'), coalesce(item.discount_value, 0),
      round(coalesce(item.line_total, item.qty * item.unit_price, 0), 2)
    );
    total := total + round(coalesce(item.line_total, item.qty * item.unit_price, 0), 2);
  end loop;

  if total <= 0 then raise exception 'COD order total must be greater than zero'; end if;
  if nullif(trim(coalesce(p_header ->> 'recipient_name', '')), '') is null then raise exception 'Customer/recipient name is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_phone', '')), '') is null then raise exception 'Customer contact number is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_address', '')), '') is null then raise exception 'Delivery address is required'; end if;

  update public.documents
  set document_no = coalesce(nullif(trim(coalesce(p_header ->> 'document_no', '')), ''), document_no),
      customer_id = nullif(p_header ->> 'customer_id', '')::uuid,
      total_amount = total,
      paid_amount = 0,
      balance_amount = total,
      document_date = coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
      notes = nullif(trim(coalesce(p_header ->> 'notes', '')), ''),
      order_source = nullif(trim(coalesce(p_header ->> 'order_source', '')), ''),
      order_taken_by = nullif(p_header ->> 'order_taken_by', '')::uuid,
      recipient_name = trim(p_header ->> 'recipient_name'),
      delivery_phone = trim(p_header ->> 'delivery_phone'),
      delivery_address = trim(p_header ->> 'delivery_address'),
      delivery_service = nullif(trim(coalesce(p_header ->> 'delivery_service', '')), ''),
      tracking_number = nullif(trim(coalesce(p_header ->> 'tracking_number', '')), ''),
      delivery_charge = greatest(coalesce(nullif(p_header ->> 'delivery_charge', '')::numeric, 0), 0),
      delivery_fee_mode = coalesce(nullif(p_header ->> 'delivery_fee_mode', ''), 'deduct_on_settlement'),
      cod_collect_amount = coalesce(nullif(p_header ->> 'cod_collect_amount', '')::numeric, total),
      updated_at = now()
  where id = p_document_id;

  perform public.apply_cod_reservation_v24(p_document_id);
  return jsonb_build_object('id', p_document_id, 'document_no', doc.document_no, 'total_amount', total);
end;
$$;

grant execute on function public.replace_cod_order_v24(uuid, jsonb, jsonb) to authenticated;

create or replace function public.update_cod_order_status_v24(
  p_document_id uuid,
  p_status text,
  p_tracking_number text default null,
  p_delivery_service text default null,
  p_payment_method_id uuid default null,
  p_delivery_fee_paid_now numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  pm record;
  fee_now numeric(12,2) := greatest(coalesce(p_delivery_fee_paid_now, 0), 0);
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if doc.status in ('converted', 'returned', 'cancelled') then raise exception 'This COD order is already closed'; end if;
  if p_status not in ('awaiting_packing', 'packed', 'dispatched', 'awaiting_settlement', 'cancelled') then
    raise exception 'Unsupported COD status: %', p_status;
  end if;

  if fee_now > 0 then
    if p_payment_method_id is null then raise exception 'Select the cash/bank payment method used for the delivery fee'; end if;
    select * into pm from public.payment_methods where id = p_payment_method_id and is_active = true;
    if not found or coalesce(pm.affects_cashflow, false) = false then raise exception 'Select an active cashflow payment method'; end if;
    insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
    values (p_document_id, 'cash_out', pm.name, pm.id, fee_now, 'Delivery fee paid for COD order ' || doc.document_no);
  end if;

  if p_status = 'cancelled' then perform public.release_cod_reservation_v24(p_document_id); end if;

  update public.documents
  set status = p_status,
      tracking_number = coalesce(nullif(trim(coalesce(p_tracking_number, '')), ''), tracking_number),
      delivery_service = coalesce(nullif(trim(coalesce(p_delivery_service, '')), ''), delivery_service),
      delivery_charge_paid = coalesce(delivery_charge_paid, 0) + fee_now,
      dispatched_at = case when p_status = 'dispatched' then coalesce(dispatched_at, now()) else dispatched_at end,
      delivered_at = case when p_status = 'awaiting_settlement' then coalesce(delivered_at, now()) else delivered_at end,
      updated_at = now()
  where id = p_document_id;
end;
$$;

grant execute on function public.update_cod_order_status_v24(uuid, text, text, text, uuid, numeric) to authenticated;

create or replace function public.return_cod_order_v24(
  p_document_id uuid,
  p_return_reason text default null,
  p_payment_method_id uuid default null,
  p_delivery_fee_charge numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  pm record;
  fee_due numeric(12,2);
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if doc.status in ('converted', 'returned', 'cancelled') then raise exception 'This COD order is already closed'; end if;

  fee_due := greatest(coalesce(p_delivery_fee_charge, doc.delivery_charge, 0) - coalesce(doc.delivery_charge_paid, 0), 0);
  if fee_due > 0 then
    if p_payment_method_id is null then raise exception 'Select the cash/bank method used for the return delivery charge'; end if;
    select * into pm from public.payment_methods where id = p_payment_method_id and is_active = true;
    if not found or coalesce(pm.affects_cashflow, false) = false then raise exception 'Select an active cashflow payment method'; end if;
    insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
    values (p_document_id, 'cash_out', pm.name, pm.id, fee_due, 'Returned COD delivery charge ' || doc.document_no);
  end if;

  perform public.release_cod_reservation_v24(p_document_id);
  update public.documents
  set status = 'returned', returned_at = now(), return_reason = nullif(trim(coalesce(p_return_reason, '')), ''),
      delivery_charge_paid = coalesce(delivery_charge_paid, 0) + fee_due,
      updated_at = now()
  where id = p_document_id;
end;
$$;

grant execute on function public.return_cod_order_v24(uuid, text, uuid, numeric) to authenticated;

create or replace function public.settle_cod_order_v24(
  p_document_id uuid,
  p_payment_method_id uuid,
  p_amount_received numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  pm record;
  item_payload jsonb;
  payment_payload jsonb;
  invoice_header jsonb;
  invoice_result jsonb;
  remaining_fee numeric(12,2);
  gross_settlement numeric(12,2);
  collect_total numeric(12,2);
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if doc.status in ('converted', 'returned', 'cancelled') then raise exception 'This COD order is already closed'; end if;
  if not coalesce(doc.cod_stock_reserved, false) then raise exception 'COD stock reservation is missing'; end if;

  select * into pm from public.payment_methods where id = p_payment_method_id and is_active = true;
  if not found or coalesce(pm.is_paid_method, false) = false or coalesce(pm.affects_cashflow, false) = false then
    raise exception 'Select an active cash/bank payment method';
  end if;

  remaining_fee := greatest(coalesce(doc.delivery_charge, 0) - coalesce(doc.delivery_charge_paid, 0), 0);
  collect_total := coalesce(nullif(doc.cod_collect_amount, 0), doc.total_amount, 0);
  gross_settlement := round(coalesce(p_amount_received, 0) + remaining_fee, 2);
  if abs(gross_settlement - collect_total) > 0.01 then
    raise exception 'Amount received plus unpaid delivery charge must equal the COD amount. Expected net receipt: %', round(collect_total - remaining_fee, 2);
  end if;

  select jsonb_agg(jsonb_build_object(
    'product_id', product_id,
    'item_code', item_code,
    'description', description,
    'qty', qty,
    'unit_price', unit_price,
    'unit_cost', unit_cost,
    'discount_type', discount_type,
    'discount_value', discount_value,
    'return_condition', null
  ) order by created_at)
  into item_payload
  from public.document_items
  where document_id = p_document_id;

  invoice_header := jsonb_build_object(
    'document_no', '',
    'customer_id', coalesce(doc.customer_id::text, ''),
    'cart_discount_type', 'amount',
    'cart_discount_value', round(doc.total_amount - collect_total, 2),
    'notes', concat('Converted from COD order ', doc.document_no, case when nullif(trim(coalesce(p_notes, '')), '') is not null then E'\n' || trim(p_notes) else '' end)
  );
  payment_payload := jsonb_build_array(jsonb_build_object(
    'payment_method_id', pm.id,
    'payment_method_name', pm.name,
    'amount', gross_settlement,
    'direction', 'in'
  ));

  -- Release inside this transaction, then create the invoice. If invoice saving
  -- fails, PostgreSQL rolls the release back and the order stays reserved.
  perform public.release_cod_reservation_v24(p_document_id);
  invoice_result := public.save_pos_invoice(invoice_header, coalesce(item_payload, '[]'::jsonb), payment_payload);

  if remaining_fee > 0 then
    insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
    values (p_document_id, 'cash_out', pm.name, pm.id, remaining_fee, 'Delivery charge deducted for COD order ' || doc.document_no);
  end if;

  update public.documents
  set status = 'converted',
      linked_document_id = (invoice_result ->> 'id')::uuid,
      paid_amount = collect_total,
      balance_amount = 0,
      payment_method_id = pm.id,
      cod_received_amount = p_amount_received,
      delivery_charge_paid = coalesce(delivery_charge_paid, 0) + remaining_fee,
      settled_at = now(),
      updated_at = now()
  where id = p_document_id;

  return jsonb_build_object(
    'order_id', p_document_id,
    'order_no', doc.document_no,
    'invoice_id', invoice_result ->> 'id',
    'invoice_no', invoice_result ->> 'document_no',
    'amount_received', p_amount_received,
    'delivery_charge', remaining_fee
  );
end;
$$;

grant execute on function public.settle_cod_order_v24(uuid, uuid, numeric, text) to authenticated;
