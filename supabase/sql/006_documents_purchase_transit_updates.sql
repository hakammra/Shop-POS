-- v6 Documents update: Purchase + Stock in Transit + Convert to Purchase
-- Run this once after previous SQL files.

create extension if not exists pgcrypto;

alter table public.documents
  add column if not exists shipping_method text,
  add column if not exists expected_arrival_date date,
  add column if not exists linked_document_id uuid references public.documents(id) on delete set null;

alter table public.stock_balances
  add column if not exists in_transit_qty numeric(12,3) not null default 0;

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  movement_type text not null check (movement_type in (
    'opening',
    'purchase_receive',
    'sale',
    'return_sellable',
    'return_damaged',
    'stock_adjustment',
    'reserve',
    'release_reserve',
    'stock_in_transit',
    'receive_from_transit',
    'damage',
    'checking'
  )),
  qty numeric(12,3) not null,
  unit_cost numeric(12,2),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.stock_movements enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_movements' and policyname = 'dev authenticated all stock_movements'
  ) then
    create policy "dev authenticated all stock_movements" on public.stock_movements for all to authenticated using (true) with check (true);
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
  next_no integer;
begin
  prefix := case p_document_type
    when 'purchase' then 'PUR'
    when 'stock_in_transit' then 'SIT'
    when 'quotation' then 'QUO'
    when 'invoice' then 'INV'
    when 'refund' then 'REF'
    else 'DOC'
  end;

  select count(*) + 1 into next_no
  from public.documents
  where document_type = p_document_type;

  return prefix || '-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(next_no::text, 4, '0');
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
  new_qty numeric(12,3);
  new_avg numeric(12,2);
begin
  if p_qty <= 0 then
    raise exception 'Received quantity must be greater than zero';
  end if;

  insert into public.stock_balances (product_id)
  values (p_product_id)
  on conflict (product_id) do nothing;

  select coalesce(sb.sellable_qty, 0), coalesce(p.avg_cost, 0)
  into old_qty, old_cost
  from public.products p
  left join public.stock_balances sb on sb.product_id = p.id
  where p.id = p_product_id
  for update;

  if not found then
    raise exception 'Product not found: %', p_product_id;
  end if;

  new_qty := old_qty + p_qty;

  if new_qty <= 0 then
    new_avg := coalesce(p_unit_cost, old_cost, 0);
  elsif old_qty <= 0 then
    new_avg := coalesce(p_unit_cost, 0);
  else
    new_avg := round(((old_qty * old_cost) + (p_qty * coalesce(p_unit_cost, 0))) / new_qty, 2);
  end if;

  update public.stock_balances
  set sellable_qty = new_qty,
      updated_at = now()
  where product_id = p_product_id;

  update public.products
  set avg_cost = new_avg,
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

create or replace function public.post_stock_in_transit_document(p_document_id uuid)
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

  if doc.document_type <> 'stock_in_transit' then
    raise exception 'Document is not stock in transit';
  end if;

  if doc.status = 'in_transit' then
    raise exception 'Stock in transit already posted';
  end if;

  for item in
    select * from public.document_items where document_id = p_document_id
  loop
    insert into public.stock_balances (product_id)
    values (item.product_id)
    on conflict (product_id) do nothing;

    update public.stock_balances
    set in_transit_qty = coalesce(in_transit_qty, 0) + item.qty,
        updated_at = now()
    where product_id = item.product_id;

    insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
    values (item.product_id, p_document_id, 'stock_in_transit', item.qty, item.unit_cost, 'Stock ordered/paid but not arrived');
  end loop;

  update public.documents
  set status = 'in_transit',
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
    concat('Converted from ', transit_doc.document_no, '. Payment/cashflow was recorded in the Stock in Transit document.'),
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

    insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
    values (item.product_id, purchase_doc_id, 'receive_from_transit', item.qty, item.unit_cost, 'Converted from stock in transit');

    perform public.apply_stock_receiving(item.product_id, item.qty, item.unit_cost, purchase_doc_id, 'Converted from stock in transit', 'purchase_receive');
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
grant execute on function public.apply_stock_receiving(uuid, numeric, numeric, uuid, text, text) to authenticated;
grant execute on function public.post_purchase_document(uuid) to authenticated;
grant execute on function public.post_stock_in_transit_document(uuid) to authenticated;
grant execute on function public.convert_stock_in_transit_to_purchase(uuid) to authenticated;
