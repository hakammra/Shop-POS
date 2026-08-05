-- Product assembly / PC build templates.
-- Assemblies are recipes only: component products remain the stock/accounting lines.

create table if not exists public.product_assemblies (
  id uuid primary key default gen_random_uuid(),
  assembly_code text not null unique,
  name text not null,
  barcode text,
  pricing_mode text not null default 'component_sum'
    check (pricing_mode in ('component_sum', 'fixed')),
  fixed_price numeric(12,2) not null default 0 check (fixed_price >= 0),
  assembly_fee numeric(12,2) not null default 0 check (assembly_fee >= 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists product_assemblies_barcode_unique
  on public.product_assemblies(barcode)
  where barcode is not null and trim(barcode) <> '';

create table if not exists public.product_assembly_items (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references public.product_assemblies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  qty numeric(12,3) not null check (qty > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (assembly_id, product_id)
);

alter table public.product_assemblies enable row level security;
alter table public.product_assembly_items enable row level security;

drop policy if exists "dev authenticated all product assemblies" on public.product_assemblies;
create policy "dev authenticated all product assemblies"
  on public.product_assemblies for all to authenticated using (true) with check (true);

drop policy if exists "dev authenticated all product assembly items" on public.product_assembly_items;
create policy "dev authenticated all product assembly items"
  on public.product_assembly_items for all to authenticated using (true) with check (true);

create or replace function public.next_assembly_code_v27()
returns text
language sql
security definer
set search_path = public
as $$
  select 'ASM-' || lpad(
    (coalesce(max(nullif(regexp_replace(assembly_code, '\D', '', 'g'), '')::integer), 0) + 1)::text,
    4,
    '0'
  )
  from public.product_assemblies;
$$;

grant execute on function public.next_assembly_code_v27() to authenticated;

create or replace function public.save_product_assembly_v27(
  p_assembly_id uuid,
  p_header jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid := p_assembly_id;
  component record;
  clean_code text := trim(coalesce(p_header ->> 'assembly_code', ''));
  clean_name text := trim(coalesce(p_header ->> 'name', ''));
  mode text := coalesce(nullif(p_header ->> 'pricing_mode', ''), 'component_sum');
begin
  if clean_code = '' then raise exception 'Assembly code is required'; end if;
  if clean_name = '' then raise exception 'Assembly name is required'; end if;
  if mode not in ('component_sum', 'fixed') then raise exception 'Unsupported assembly pricing mode'; end if;
  if mode = 'fixed' and coalesce((p_header ->> 'fixed_price')::numeric, 0) <= 0 then
    raise exception 'Fixed package price must be greater than zero';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one component';
  end if;

  if target_id is null then
    insert into public.product_assemblies (
      assembly_code, name, barcode, pricing_mode, fixed_price, assembly_fee, is_active
    ) values (
      clean_code,
      clean_name,
      nullif(trim(coalesce(p_header ->> 'barcode', '')), ''),
      mode,
      greatest(coalesce((p_header ->> 'fixed_price')::numeric, 0), 0),
      greatest(coalesce((p_header ->> 'assembly_fee')::numeric, 0), 0),
      coalesce((p_header ->> 'is_active')::boolean, true)
    ) returning id into target_id;
  else
    update public.product_assemblies
    set assembly_code = clean_code,
        name = clean_name,
        barcode = nullif(trim(coalesce(p_header ->> 'barcode', '')), ''),
        pricing_mode = mode,
        fixed_price = greatest(coalesce((p_header ->> 'fixed_price')::numeric, 0), 0),
        assembly_fee = greatest(coalesce((p_header ->> 'assembly_fee')::numeric, 0), 0),
        is_active = coalesce((p_header ->> 'is_active')::boolean, true),
        updated_at = now()
    where id = target_id;
    if not found then raise exception 'Assembly not found'; end if;
    delete from public.product_assembly_items where assembly_id = target_id;
  end if;

  for component in
    select *
    from jsonb_to_recordset(p_items) as x(product_id uuid, qty numeric, sort_order integer)
  loop
    if component.product_id is null or coalesce(component.qty, 0) <= 0 then
      raise exception 'Every assembly component needs a product and quantity greater than zero';
    end if;
    insert into public.product_assembly_items (assembly_id, product_id, qty, sort_order)
    values (target_id, component.product_id, component.qty, coalesce(component.sort_order, 0));
  end loop;

  return target_id;
end;
$$;

grant execute on function public.save_product_assembly_v27(uuid, jsonb, jsonb) to authenticated;

create or replace view public.product_assembly_pos_view
with (security_invoker = true)
as
select
  a.id,
  a.assembly_code,
  a.name,
  a.barcode,
  a.pricing_mode,
  a.fixed_price,
  a.assembly_fee,
  a.is_active,
  a.created_at,
  a.updated_at,
  coalesce(component_data.components, '[]'::jsonb) as components,
  coalesce(component_data.component_price, 0)::numeric(12,2) as component_price,
  case
    when a.pricing_mode = 'fixed' then a.fixed_price + a.assembly_fee
    else coalesce(component_data.component_price, 0) + a.assembly_fee
  end::numeric(12,2) as selling_price,
  coalesce(component_data.component_cost, 0)::numeric(12,2) as component_cost,
  coalesce(component_data.buildable_qty, 0)::integer as buildable_qty
from public.product_assemblies a
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'product_id', p.id,
        'item_code', p.item_code,
        'name', p.name,
        'qty', ai.qty,
        'selling_price', p.selling_price,
        'avg_cost', p.avg_cost,
        'available_qty', greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0),
        'is_active', p.is_active
      ) order by ai.sort_order, p.item_code
    ) as components,
    sum(ai.qty * p.selling_price) as component_price,
    sum(ai.qty * p.avg_cost) as component_cost,
    min(case when p.is_active then floor(greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) / ai.qty) else 0 end) as buildable_qty
  from public.product_assembly_items ai
  join public.products p on p.id = ai.product_id
  left join public.stock_balances sb on sb.product_id = p.id
  where ai.assembly_id = a.id
) component_data on true;

grant select on public.product_assembly_pos_view to authenticated;
