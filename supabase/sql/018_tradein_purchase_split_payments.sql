-- v18: Trade-in / Buyback Intake + purchase split payments + party outstanding balance.
-- Run once after 017.

alter table public.documents
  add column if not exists party_balance_applied boolean not null default false,
  add column if not exists party_balance_delta numeric(12,2) not null default 0,
  add column if not exists party_balance_customer_id uuid references public.customers(id) on delete set null;

-- The stock_movements check list in older installs may not include buyback_intake.
-- We store trade-in intake as a document + non_cash entry only, no stock movement yet.

create or replace function public.apply_document_party_balance_v18(p_document_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  new_delta numeric(12,2) := 0;
  new_balance numeric(12,2) := 0;
begin
  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found while applying party balance';
  end if;

  -- Reverse the previous balance effect if this document was already applied.
  if coalesce(doc.party_balance_applied, false) and doc.party_balance_customer_id is not null and coalesce(doc.party_balance_delta, 0) <> 0 then
    perform public.apply_customer_outstanding_delta(doc.party_balance_customer_id, -1 * doc.party_balance_delta);
  end if;

  if doc.document_type in ('purchase', 'stock_in_transit') then
    -- Purchase total means shop owes party. Paid amount means shop already paid them.
    new_delta := round(-1 * coalesce(doc.total_amount, 0) + coalesce(doc.paid_amount, 0), 2);
  elsif doc.document_type = 'trade_in' then
    -- Trade-in intake total is stored as a negative amount. It increases shop-owes-customer balance.
    new_delta := round(coalesce(doc.total_amount, 0), 2);
  else
    new_delta := 0;
  end if;

  if doc.customer_id is not null and new_delta <> 0 then
    new_balance := public.apply_customer_outstanding_delta(doc.customer_id, new_delta);
  end if;

  update public.documents
  set party_balance_applied = true,
      party_balance_delta = new_delta,
      party_balance_customer_id = customer_id,
      updated_at = now()
  where id = p_document_id;

  return new_balance;
end;
$$;

grant execute on function public.apply_document_party_balance_v18(uuid) to authenticated;

create or replace function public.save_trade_in_intake_v18(
  p_customer_id uuid,
  p_document_no text,
  p_external_no text,
  p_document_date text,
  p_description text,
  p_estimated_value numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  doc_no text;
  new_balance numeric(12,2);
begin
  if p_customer_id is null then
    raise exception 'Customer/profile is required';
  end if;
  if coalesce(p_estimated_value, 0) <= 0 then
    raise exception 'Estimated value must be greater than zero';
  end if;

  doc_no := nullif(trim(coalesce(p_document_no, '')), '');
  if doc_no is null then
    doc_no := public.next_document_no('trade_in');
  end if;

  insert into public.documents (
    document_no,
    external_document_no,
    document_type,
    status,
    customer_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    document_date,
    notes
  ) values (
    doc_no,
    nullif(trim(coalesce(p_external_no, '')), ''),
    'trade_in',
    'pending_stock_breakdown',
    p_customer_id,
    -1 * round(p_estimated_value, 2),
    0,
    -1 * round(p_estimated_value, 2),
    'LKR',
    coalesce(nullif(p_document_date, '')::date, current_date)::timestamptz,
    nullif(trim(coalesce(p_notes, '')), '')
  ) returning id into doc_id;

  insert into public.document_items (
    document_id, product_id, item_code, description, qty, unit_price, unit_cost, line_total
  ) values (
    doc_id, null, null, coalesce(nullif(trim(p_description), ''), 'Trade-in / buyback intake'), 1,
    -1 * round(p_estimated_value, 2), 0, -1 * round(p_estimated_value, 2)
  );

  insert into public.cashflow_entries (document_id, entry_type, account_name, amount, description)
  values (doc_id, 'non_cash', 'Outstanding', p_estimated_value, 'Trade-in/buyback intake credit ' || doc_no);

  new_balance := public.apply_document_party_balance_v18(doc_id);

  return jsonb_build_object('id', doc_id, 'document_no', doc_no, 'new_outstanding', new_balance);
end;
$$;

grant execute on function public.save_trade_in_intake_v18(uuid, text, text, text, text, numeric, text) to authenticated;

create or replace function public.save_purchase_like_document_v18(
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
  doc_id uuid;
  doc_type text;
  doc_no text;
  item record;
  pay record;
  pm record;
  total numeric(12,2) := 0;
  paid numeric(12,2) := 0;
  first_pm_id uuid;
  cash_amount numeric(12,2);
  new_balance numeric(12,2) := 0;
begin
  doc_type := coalesce(nullif(p_header ->> 'document_type', ''), 'purchase');
  if doc_type not in ('purchase', 'stock_in_transit') then
    raise exception 'Unsupported purchase-like document type: %', doc_type;
  end if;

  doc_no := nullif(trim(coalesce(p_header ->> 'document_no', '')), '');
  if doc_no is null then
    doc_no := public.next_document_no(doc_type);
  end if;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_cost numeric
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every item must have a product and quantity greater than zero';
    end if;
    total := total + round(item.qty * coalesce(item.unit_cost, 0), 2);
  end loop;

  if total <= 0 then
    raise exception 'Document total must be greater than zero';
  end if;

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(
      payment_method_id uuid,
      payment_method_name text,
      amount numeric
    )
  loop
    if coalesce(pay.amount, 0) <= 0 then
      raise exception 'Payment amount must be greater than zero';
    end if;
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if not found then
      raise exception 'Payment method not found';
    end if;
    if first_pm_id is null then
      first_pm_id := pm.id;
    end if;
    if coalesce(pm.is_paid_method, true) then
      paid := paid + pay.amount;
    end if;
  end loop;

  if first_pm_id is null then
    raise exception 'Add at least one payment line. Use Credit if nothing was paid now.';
  end if;

  insert into public.documents (
    document_no,
    external_document_no,
    document_type,
    status,
    supplier_id,
    customer_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    payment_method_id,
    document_date,
    shipping_method,
    expected_arrival_date,
    notes
  ) values (
    doc_no,
    nullif(p_header ->> 'external_document_no', ''),
    doc_type,
    'draft',
    nullif(p_header ->> 'supplier_id', '')::uuid,
    nullif(p_header ->> 'customer_id', '')::uuid,
    total,
    paid,
    total - paid,
    'LKR',
    first_pm_id,
    coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
    nullif(p_header ->> 'shipping_method', ''),
    nullif(p_header ->> 'expected_arrival_date', '')::date,
    nullif(p_header ->> 'notes', '')
  ) returning id into doc_id;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_cost numeric
    )
  loop
    insert into public.document_items (document_id, product_id, item_code, description, qty, unit_cost, unit_price, line_total)
    values (doc_id, item.product_id, item.item_code, item.description, item.qty, coalesce(item.unit_cost, 0), coalesce(item.unit_cost, 0), round(item.qty * coalesce(item.unit_cost, 0), 2));
  end loop;

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(
      payment_method_id uuid,
      payment_method_name text,
      amount numeric
    )
  loop
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if coalesce(pm.is_paid_method, true) then
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (doc_id, 'cash_out', pm.name, pm.id, pay.amount, (case when doc_type = 'purchase' then 'Purchase' when doc_type = 'stock_in_transit' then 'Stock in Transit' else 'Document' end) || ' payment ' || doc_no);
    else
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (doc_id, 'non_cash', pm.name, pm.id, pay.amount, (case when doc_type = 'purchase' then 'Purchase' when doc_type = 'stock_in_transit' then 'Stock in Transit' else 'Document' end) || ' outstanding/credit ' || doc_no);
    end if;
  end loop;

  if doc_type = 'purchase' then
    perform public.post_purchase_document(doc_id);
  else
    perform public.post_stock_in_transit_document(doc_id);
  end if;

  new_balance := public.apply_document_party_balance_v18(doc_id);

  return jsonb_build_object('id', doc_id, 'document_no', doc_no, 'new_outstanding', new_balance);
end;
$$;

grant execute on function public.save_purchase_like_document_v18(jsonb, jsonb, jsonb) to authenticated;

drop function if exists public.replace_purchase_like_document_v18(uuid, jsonb, jsonb, jsonb);
create or replace function public.replace_purchase_like_document_v18(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  pay record;
  pm record;
  total numeric(12,2) := 0;
  paid numeric(12,2) := 0;
  first_pm_id uuid;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'Document not found'; end if;
  if doc.document_type not in ('purchase', 'stock_in_transit') then raise exception 'Only Purchase and Stock in Transit editing is supported now'; end if;

  -- Reverse old party balance before stock reversal/deleting old rows.
  if coalesce(doc.party_balance_applied, false) and doc.party_balance_customer_id is not null and coalesce(doc.party_balance_delta, 0) <> 0 then
    perform public.apply_customer_outstanding_delta(doc.party_balance_customer_id, -1 * doc.party_balance_delta);
  end if;
  update public.documents set party_balance_applied = false, party_balance_delta = 0, party_balance_customer_id = null where id = p_document_id;

  perform public.reverse_purchase_like_document(p_document_id);
  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.document_items where document_id = p_document_id;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(product_id uuid, item_code text, description text, qty numeric, unit_cost numeric)
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then raise exception 'Every item must have a product and quantity greater than zero'; end if;
    insert into public.document_items (document_id, product_id, item_code, description, qty, unit_cost, unit_price, line_total)
    values (p_document_id, item.product_id, item.item_code, item.description, item.qty, coalesce(item.unit_cost, 0), coalesce(item.unit_cost, 0), round(item.qty * coalesce(item.unit_cost, 0), 2));
    total := total + round(item.qty * coalesce(item.unit_cost, 0), 2);
  end loop;

  if total <= 0 then raise exception 'Document total must be greater than zero'; end if;

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(payment_method_id uuid, payment_method_name text, amount numeric)
  loop
    if coalesce(pay.amount, 0) <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if not found then raise exception 'Payment method not found'; end if;
    if first_pm_id is null then first_pm_id := pm.id; end if;
    if coalesce(pm.is_paid_method, true) then paid := paid + pay.amount; end if;
  end loop;

  if first_pm_id is null then raise exception 'Add at least one payment line. Use Credit if nothing was paid now.'; end if;

  update public.documents
  set document_no = coalesce(nullif(p_header ->> 'document_no', ''), document_no),
      external_document_no = nullif(p_header ->> 'external_document_no', ''),
      supplier_id = nullif(p_header ->> 'supplier_id', '')::uuid,
      customer_id = nullif(p_header ->> 'customer_id', '')::uuid,
      payment_method_id = first_pm_id,
      document_date = coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
      shipping_method = nullif(p_header ->> 'shipping_method', ''),
      expected_arrival_date = nullif(p_header ->> 'expected_arrival_date', '')::date,
      notes = nullif(p_header ->> 'notes', ''),
      total_amount = total,
      paid_amount = paid,
      balance_amount = total - paid,
      currency = 'LKR',
      status = 'draft',
      updated_at = now()
  where id = p_document_id;

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(payment_method_id uuid, payment_method_name text, amount numeric)
  loop
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if coalesce(pm.is_paid_method, true) then
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (p_document_id, 'cash_out', pm.name, pm.id, pay.amount, 'Edited ' || doc.document_type || ' payment ' || coalesce(p_header ->> 'document_no', doc.document_no));
    else
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (p_document_id, 'non_cash', pm.name, pm.id, pay.amount, 'Edited ' || doc.document_type || ' outstanding/credit ' || coalesce(p_header ->> 'document_no', doc.document_no));
    end if;
  end loop;

  if doc.document_type = 'purchase' then perform public.post_purchase_document(p_document_id); else perform public.post_stock_in_transit_document(p_document_id); end if;
  perform public.apply_document_party_balance_v18(p_document_id);
end;
$$;

grant execute on function public.replace_purchase_like_document_v18(uuid, jsonb, jsonb, jsonb) to authenticated;

-- Replace delete to reverse party balance too.
create or replace function public.delete_purchase_like_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'Document not found'; end if;
  if doc.document_type not in ('purchase', 'stock_in_transit') then raise exception 'Only Purchase and Stock in Transit documents can be deleted with automatic stock reversal now'; end if;
  if doc.document_type = 'stock_in_transit' and doc.status = 'converted' then raise exception 'This Stock in Transit document is already converted. Delete/edit the linked Purchase document instead.'; end if;

  if coalesce(doc.party_balance_applied, false) and doc.party_balance_customer_id is not null and coalesce(doc.party_balance_delta, 0) <> 0 then
    perform public.apply_customer_outstanding_delta(doc.party_balance_customer_id, -1 * doc.party_balance_delta);
  end if;

  perform public.reverse_purchase_like_document(p_document_id);
  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.documents where id = p_document_id;
end;
$$;

grant execute on function public.delete_purchase_like_document(uuid) to authenticated;
