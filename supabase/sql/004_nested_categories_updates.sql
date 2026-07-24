-- Nested category support for product imports such as:
-- Accessories/Cables, SSD/SSD NEW/M.2 NVMe NEW
-- Run this once after 001, 002, and 003.

create extension if not exists pgcrypto;

alter table public.categories
  add column if not exists parent_id uuid references public.categories(id) on delete restrict,
  add column if not exists path text;

-- The old schema had categories.name as unique. Nested categories need path-based uniqueness instead.
alter table public.categories drop constraint if exists categories_name_key;

update public.categories
set path = name
where path is null;

-- Helper function used by the app import/new group button.
create or replace function public.get_or_create_category_path(p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_path text;
  parts text[];
  part text;
  current_path text := '';
  parent_uuid uuid := null;
  current_uuid uuid := null;
begin
  clean_path := regexp_replace(coalesce(p_path, ''), '\\+', '/', 'g');
  clean_path := regexp_replace(clean_path, '/+', '/', 'g');
  clean_path := trim(both '/' from clean_path);

  if clean_path = '' then
    return null;
  end if;

  parts := string_to_array(clean_path, '/');

  foreach part in array parts loop
    part := trim(part);
    if part = '' then
      continue;
    end if;

    if current_path = '' then
      current_path := part;
    else
      current_path := current_path || '/' || part;
    end if;

    select id into current_uuid
    from public.categories
    where lower(path) = lower(current_path)
    limit 1;

    if current_uuid is null then
      insert into public.categories (name, parent_id, path)
      values (part, parent_uuid, current_path)
      returning id into current_uuid;
    else
      update public.categories
      set name = part,
          parent_id = parent_uuid,
          path = current_path
      where id = current_uuid;
    end if;

    parent_uuid := current_uuid;
  end loop;

  return current_uuid;
end;
$$;

-- Convert any old flat slash categories into a proper nested tree while keeping product links.
do $$
declare
  cat record;
  parent_path text;
  leaf_name text;
  parent_uuid uuid;
begin
  for cat in
    select id, coalesce(path, name) as old_path
    from public.categories
    where coalesce(path, name) like '%/%'
    order by length(coalesce(path, name))
  loop
    parent_path := regexp_replace(cat.old_path, '/[^/]+$', '');
    leaf_name := trim((string_to_array(cat.old_path, '/'))[array_length(string_to_array(cat.old_path, '/'), 1)]);
    parent_uuid := public.get_or_create_category_path(parent_path);

    update public.categories
    set name = leaf_name,
        parent_id = parent_uuid,
        path = cat.old_path
    where id = cat.id;
  end loop;
end $$;

-- Fill any remaining missing paths.
update public.categories
set path = name
where path is null;

-- Ensure each category path is unique, case-insensitive.
create unique index if not exists categories_lower_path_unique_idx
on public.categories (lower(path));

-- Recreate product stock view with category_path included.
drop view if exists public.product_stock_view;

create view public.product_stock_view
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
  c.path as category_path,
  c.parent_id as category_parent_id,
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
