-- v7 fixes: document numbering, product auto-code, purchase posting stock fix.
-- Run this once after 006_documents_purchase_transit_updates.sql.

create extension if not exists pgcrypto;

create table if not exists public.document_sequences (
  document_type text not null,
  document_year integer not null,
  last_no integer not null default 0,
  primary key (document_type, document_year)
);

alter table public.document_sequences enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'document_sequences' and policyname = 'dev authenticated all document_sequences'
  ) then
    create policy "dev authenticated all document_sequences" on public.document_sequences for all to authenticated using (true) with check (true);
  end if;
end $$;

create or replace function public.next_document_no(p_document_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text;
  doc_year integer;
  next_no integer;
begin
  prefix := case p_document_type
    when 'purchase' then 'PUR'
    when 'stock_in_transit' then 'SIT'
    when 'quotation' then 'QUO'
    when 'invoice' then 'INV'
    when 'refund' then 'REF'
    when 'stock_adjustment' then 'STA'
    when 'trade_in' then 'TRD'
    when 'customer_payment' then 'CPY'
    when 'supplier_payment' then 'SPY'
    when 'expense' then 'EXP'
    when 'online_order' then 'ONL'
    else 'DOC'
  end;

  doc_year := extract(year from now())::integer;

  insert into public.document_sequences (document_type, document_year, last_no)
  values (p_document_type, doc_year, 1)
  on conflict (document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return prefix || '-' || doc_year::text || '-' || lpad(next_no::text, 5, '0');
end;
$$;

create or replace function public.next_product_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  max_code bigint;
begin
  select max(code_num) into max_code
  from (
    select nullif(regexp_replace(coalesce(item_code, ''), '\\D', '', 'g'), '')::bigint as code_num
    from public.products
  ) x
  where code_num is not null;

  return (coalesce(max_code, 0) + 1)::text;
end;
$$;

create or replace function public.apply_stock_receiving(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_document_id uuid default null,
  p_notes text default null,
  p_movement_type text default 'purchase_receive'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_qty numeric(12,3);
  old_cost numeric(12,2);
  old_price numeric(12,2);
  old_markup numeric;
  new_qty numeric(12,3);
  new_avg numeric(12,2);
  new_price numeric(12,2);
begin
  if p_qty <= 0 then
    raise exception 'Received quantity must be greater than zero';
  end if;

  insert into public.stock_balances (product_id)
  values (p_product_id)
  on conflict (product_id) do nothing;

  -- Lock the product and stock row separately. This avoids FOR UPDATE on the nullable side of a left join.
  select coalesce(avg_cost, 0), coalesce(selling_price, 0)
  into old_cost, old_price
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Product not found: %', p_product_id;
  end if;

  select coalesce(sellable_qty, 0)
  into old_qty
  from public.stock_balances
  where product_id = p_product_id
  for update;

  new_qty := old_qty + p_qty;

  if new_qty <= 0 then
    new_avg := coalesce(p_unit_cost, old_cost, 0);
  elsif old_qty <= 0 then
    new_avg := coalesce(p_unit_cost, 0);
  else
    new_avg := round(((old_qty * old_cost) + (p_qty * coalesce(p_unit_cost, 0))) / new_qty, 2);
  end if;

  -- Preserve the existing markup when cost changes, if the product already had cost and price.
  if old_cost > 0 and old_price > 0 then
    old_markup := (old_price - old_cost) / old_cost;
    new_price := round(new_avg * (1 + old_markup), 2);
  else
    new_price := old_price;
  end if;

  update public.stock_balances
  set sellable_qty = new_qty,
      updated_at = now()
  where product_id = p_product_id;

  update public.products
  set avg_cost = new_avg,
      selling_price = new_price,
      updated_at = now()
  where id = p_product_id;

  insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
  values (p_product_id, p_document_id, p_movement_type, p_qty, p_unit_cost, p_notes);
end;
$$;

create or replace function public.post_purchase_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
begin
  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found';
  end if;

  if doc.document_type <> 'purchase' then
    raise exception 'Document is not a purchase';
  end if;

  if doc.status = 'completed' then
    raise exception 'Purchase already posted';
  end if;

  for item in
    select * from public.document_items where document_id = p_document_id
  loop
    perform public.apply_stock_receiving(item.product_id, item.qty, item.unit_cost, p_document_id, 'Purchase document stock received', 'purchase_receive');
  end loop;

  update public.documents
  set status = 'completed',
      updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.convert_stock_in_transit_to_purchase(p_transit_doc_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  transit_doc record;
  item record;
  purchase_doc_id uuid;
  new_doc_no text;
begin
  select * into transit_doc
  from public.documents
  where id = p_transit_doc_id
  for update;

  if not found then
    raise exception 'Stock in Transit document not found';
  end if;

  if transit_doc.document_type <> 'stock_in_transit' then
    raise exception 'Selected document is not Stock in Transit';
  end if;

  if transit_doc.status <> 'in_transit' then
    raise exception 'Only in_transit documents can be converted. Current status: %', transit_doc.status;
  end if;

  new_doc_no := public.next_document_no('purchase');

  insert into public.documents (
    document_no,
    external_document_no,
    document_type,
    status,
    supplier_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    notes,
    payment_method_id,
    document_date,
    shipping_method,
    linked_document_id
  ) values (
    new_doc_no,
    transit_doc.external_document_no,
    'purchase',
    'draft',
    transit_doc.supplier_id,
    transit_doc.total_amount,
    transit_doc.paid_amount,
    transit_doc.balance_amount,
    transit_doc.currency,
    concat('Converted from ', transit_doc.document_no, '. Payment/cashflow was already recorded in the Stock in Transit document.'),
    transit_doc.payment_method_id,
    now(),
    transit_doc.shipping_method,
    transit_doc.id
  ) returning id into purchase_doc_id;

  insert into public.document_items (document_id, product_id, item_code, description, qty, unit_price, unit_cost, discount_type, discount_value, line_total)
  select purchase_doc_id, product_id, item_code, description, qty, unit_price, unit_cost, discount_type, discount_value, line_total
  from public.document_items
  where document_id = p_transit_doc_id;

  for item in
    select * from public.document_items where document_id = p_transit_doc_id
  loop
    update public.stock_balances
    set in_transit_qty = greatest(coalesce(in_transit_qty, 0) - item.qty, 0),
        updated_at = now()
    where product_id = item.product_id;

    perform public.apply_stock_receiving(item.product_id, item.qty, item.unit_cost, purchase_doc_id, 'Converted from stock in transit', 'receive_from_transit');
  end loop;

  update public.documents
  set status = 'converted',
      linked_document_id = purchase_doc_id,
      updated_at = now()
  where id = p_transit_doc_id;

  update public.documents
  set status = 'completed',
      updated_at = now()
  where id = purchase_doc_id;

  return purchase_doc_id;
end;
$$;

grant execute on function public.next_document_no(text) to authenticated;
grant execute on function public.next_product_code() to authenticated;
grant execute on function public.apply_stock_receiving(uuid, numeric, numeric, uuid, text, text) to authenticated;
grant execute on function public.post_purchase_document(uuid) to authenticated;
grant execute on function public.convert_stock_in_transit_to_purchase(uuid) to authenticated;
