-- Structure update for Aronium-style layout and future POS modules.
-- Safe to run after 001_initial_schema.sql and after your Aronium import.

create extension if not exists pgcrypto;

-- Staff table for users/security screen.
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'cashier' check (role in ('admin', 'manager', 'cashier')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.staff enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'staff' and policyname = 'dev authenticated all staff'
  ) then
    create policy "dev authenticated all staff" on public.staff for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Add in-transit quantity for stock page display.
alter table public.stock_balances
  add column if not exists in_transit_qty numeric(12,3) not null default 0;

-- Extra document columns for Aronium-like filtering. Existing documents remain valid.
alter table public.documents
  add column if not exists external_document_no text,
  add column if not exists source text not null default 'manual' check (source in ('pos', 'online', 'manual')),
  add column if not exists cash_register_name text,
  add column if not exists payment_method_id uuid references public.payment_methods(id) on delete set null,
  add column if not exists document_date timestamptz not null default now();

-- Extend product stock view without changing existing column order.
create or replace view public.product_stock_view
with (security_invoker = true)
as
select
  p.id as product_id,
  p.item_code,
  p.name,
  p.selling_price,
  p.avg_cost,
  p.min_stock_level,
  p.online_visible,
  p.is_active,
  c.name as category_name,
  b.name as brand_name,
  coalesce(s.sellable_qty, 0) as sellable_qty,
  coalesce(s.reserved_qty, 0) as reserved_qty,
  coalesce(s.damaged_qty, 0) as damaged_qty,
  coalesce(s.checking_qty, 0) as checking_qty,
  coalesce(s.sellable_qty, 0) - coalesce(s.reserved_qty, 0) as available_qty,
  coalesce(s.in_transit_qty, 0) as in_transit_qty,
  (coalesce(s.sellable_qty, 0) * coalesce(p.avg_cost, 0)) as sellable_stock_value
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id;

-- Optional company settings table. We will connect the My Company screen later.
create table if not exists public.company_settings (
  id boolean primary key default true,
  shop_name text,
  phone text,
  address text,
  currency text not null default 'LKR',
  invoice_footer text,
  show_item_code boolean not null default true,
  show_serial_number boolean not null default true,
  show_warranty boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint company_settings_single_row check (id = true)
);

alter table public.company_settings enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'company_settings' and policyname = 'dev authenticated all company_settings'
  ) then
    create policy "dev authenticated all company_settings" on public.company_settings for all to authenticated using (true) with check (true);
  end if;
end $$;

insert into public.company_settings (id, currency)
values (true, 'LKR')
on conflict (id) do nothing;
