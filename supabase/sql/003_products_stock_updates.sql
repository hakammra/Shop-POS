-- Products + stock update for the simplified product fields requested.
-- Run this once after 001_initial_schema.sql and 002_structure_updates.sql.
-- Safe to run more than once.

create extension if not exists pgcrypto;

-- Product status: keep is_active for compatibility, but use status in the UI.
alter table public.products
  add column if not exists status text not null default 'active' check (status in ('active', 'inactive'));

update public.products
set status = case when is_active then 'active' else 'inactive' end;

alter table public.products
  alter column online_visible set default false;

-- Stock balance columns used by the Stock page.
alter table public.stock_balances
  add column if not exists in_transit_qty numeric(12,3) not null default 0;

-- Helpful indexes for item code/name/barcode search.
create index if not exists idx_products_item_code on public.products (item_code);
create index if not exists idx_products_name on public.products (name);
create index if not exists idx_products_barcode on public.products (barcode);
create index if not exists idx_products_category_id on public.products (category_id);

-- Stock movements will be used later by Purchase, Stock in Transit, Stock Receiving,
-- Reservation, Returns, and Stock Adjustment documents.
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

-- Moving average receiving helper.
-- Later purchase/stock receiving documents will call this function.
create or replace function public.apply_stock_receiving(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_document_id uuid default null,
  p_notes text default null
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
  values (p_product_id, p_document_id, 'purchase_receive', p_qty, p_unit_cost, p_notes);
end;
$$;

-- View used by Products, Stock, and POS search.
create or replace view public.product_stock_view
with (security_invoker = true)
as
select
  p.id as product_id,
  p.item_code,
  p.name,
  p.category_id,
  p.barcode,
  p.selling_price,
  p.avg_cost,
  case
    when coalesce(p.avg_cost, 0) <= 0 then 0
    else round(((coalesce(p.selling_price, 0) - coalesce(p.avg_cost, 0)) / nullif(p.avg_cost, 0)) * 100, 2)
  end as markup_percent,
  p.min_stock_level,
  p.online_visible,
  p.is_active,
  p.status,
  c.name as category_name,
  b.name as brand_name,
  coalesce(s.sellable_qty, 0) as sellable_qty,
  coalesce(s.sellable_qty, 0) as quantity,
  coalesce(s.reserved_qty, 0) as reserved_qty,
  coalesce(s.damaged_qty, 0) as damaged_qty,
  coalesce(s.checking_qty, 0) as checking_qty,
  coalesce(s.sellable_qty, 0) - coalesce(s.reserved_qty, 0) as available_qty,
  coalesce(s.in_transit_qty, 0) as in_transit_qty,
  (coalesce(s.sellable_qty, 0) * coalesce(p.avg_cost, 0)) as total_cost_value,
  (coalesce(s.sellable_qty, 0) * coalesce(p.selling_price, 0)) as total_sale_value,
  (coalesce(s.in_transit_qty, 0) * coalesce(p.avg_cost, 0)) as in_transit_value,
  (coalesce(s.sellable_qty, 0) <= coalesce(p.min_stock_level, 1)) as is_low_stock
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id;
