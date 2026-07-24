-- Computer Shop POS starter schema
-- Run this in Supabase SQL Editor for the first local/cloud test.

create extension if not exists pgcrypto;

-- =========================
-- Master data
-- =========================
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  affects_cashflow boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  item_code text not null unique,
  name text not null,
  category_id uuid references public.categories(id) on delete set null,
  brand_id uuid references public.brands(id) on delete set null,
  barcode text,
  model_number text,
  description text,
  selling_price numeric(12,2) not null default 0,
  avg_cost numeric(12,2) not null default 0,
  min_selling_price numeric(12,2),
  min_stock_level numeric(12,3) not null default 0,
  warranty_months integer not null default 0,
  serial_required boolean not null default false,
  online_visible boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stock_balances (
  product_id uuid primary key references public.products(id) on delete cascade,
  sellable_qty numeric(12,3) not null default 0,
  reserved_qty numeric(12,3) not null default 0,
  damaged_qty numeric(12,3) not null default 0,
  checking_qty numeric(12,3) not null default 0,
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  store_credit_balance numeric(12,2) not null default 0,
  due_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  payable_balance numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Draft bills will support multiple pending POS bills later.
create table public.pos_drafts (
  id uuid primary key default gen_random_uuid(),
  draft_name text not null,
  customer_id uuid references public.customers(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- This will later hold invoice, quotation, purchase, stock-in-transit, expense, etc.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  document_no text not null unique,
  document_type text not null check (document_type in (
    'invoice',
    'quotation',
    'purchase',
    'stock_in_transit',
    'stock_receiving',
    'refund',
    'trade_in',
    'customer_payment',
    'supplier_payment',
    'expense',
    'stock_adjustment',
    'online_order'
  )),
  status text not null default 'draft',
  customer_id uuid references public.customers(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  total_amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  balance_amount numeric(12,2) not null default 0,
  currency text not null default 'LKR',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  item_code text,
  description text not null,
  qty numeric(12,3) not null default 1,
  unit_price numeric(12,2) not null default 0,
  unit_cost numeric(12,2) not null default 0,
  discount_type text not null default 'none' check (discount_type in ('none', 'amount', 'percent')),
  discount_value numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0,
  return_condition text check (return_condition in ('sellable', 'warranty_damaged')),
  created_at timestamptz not null default now()
);

create table public.cashflow_entries (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete set null,
  entry_type text not null check (entry_type in ('cash_in', 'cash_out', 'non_cash')),
  account_name text not null default 'Cash Drawer',
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  amount numeric(12,2) not null,
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Product + stock readable view for UI search tables.
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
  coalesce(s.sellable_qty, 0) - coalesce(s.reserved_qty, 0) as available_qty
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id;

-- =========================
-- Seed data
-- =========================
insert into public.categories (name) values
  ('Laptops'), ('Desktops'), ('RAM'), ('SSD'), ('HDD'), ('Monitors'), ('Keyboards'), ('Mouse'), ('Accessories'), ('Used Items')
on conflict (name) do nothing;

insert into public.brands (name) values
  ('Dell'), ('HP'), ('Lenovo'), ('Asus'), ('Acer'), ('Kingston'), ('Logitech'), ('Samsung'), ('Other')
on conflict (name) do nothing;

insert into public.payment_methods (name, affects_cashflow) values
  ('Cash', true),
  ('Card', true),
  ('Bank', true),
  ('Credit', false),
  ('Store Credit', false),
  ('Online Payment', true)
on conflict (name) do nothing;

-- =========================
-- RLS for development
-- Later we will replace this with role-based policies.
-- =========================
alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.payment_methods enable row level security;
alter table public.products enable row level security;
alter table public.stock_balances enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table public.pos_drafts enable row level security;
alter table public.documents enable row level security;
alter table public.document_items enable row level security;
alter table public.cashflow_entries enable row level security;

create policy "dev authenticated all categories" on public.categories for all to authenticated using (true) with check (true);
create policy "dev authenticated all brands" on public.brands for all to authenticated using (true) with check (true);
create policy "dev authenticated all payment methods" on public.payment_methods for all to authenticated using (true) with check (true);
create policy "dev authenticated all products" on public.products for all to authenticated using (true) with check (true);
create policy "dev authenticated all stock balances" on public.stock_balances for all to authenticated using (true) with check (true);
create policy "dev authenticated all customers" on public.customers for all to authenticated using (true) with check (true);
create policy "dev authenticated all suppliers" on public.suppliers for all to authenticated using (true) with check (true);
create policy "dev authenticated all pos drafts" on public.pos_drafts for all to authenticated using (true) with check (true);
create policy "dev authenticated all documents" on public.documents for all to authenticated using (true) with check (true);
create policy "dev authenticated all document items" on public.document_items for all to authenticated using (true) with check (true);
create policy "dev authenticated all cashflow" on public.cashflow_entries for all to authenticated using (true) with check (true);
