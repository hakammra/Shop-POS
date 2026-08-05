-- v37: Non-stock products and services.
-- Run once after 036_invoice_returns_and_zero_exchanges.sql.

alter table public.products
  add column if not exists track_inventory boolean not null default true;

comment on column public.products.track_inventory is
  'When false, the product can be sold without stock checks and creates no stock movements.';

-- Old backups do not contain track_inventory. This trigger supplies the safe
-- default during restore and prevents hiding real stock by turning tracking off.
create or replace function public.validate_product_inventory_tracking_v37()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  stock_row public.stock_balances%rowtype;
begin
  new.track_inventory := coalesce(new.track_inventory, true);

  if tg_op = 'UPDATE' then
    if coalesce(old.track_inventory, true) and not new.track_inventory then
      select * into stock_row from public.stock_balances where product_id = new.id;
      if found and (
        coalesce(stock_row.sellable_qty, 0) <> 0
        or coalesce(stock_row.reserved_qty, 0) <> 0
        or coalesce(stock_row.in_transit_qty, 0) <> 0
        or coalesce(stock_row.damaged_qty, 0) <> 0
        or coalesce(stock_row.checking_qty, 0) <> 0
      ) then
        raise exception 'Set all stock quantities to zero before turning off inventory tracking for %', new.item_code;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_product_inventory_tracking_v37_trigger on public.products;
create trigger validate_product_inventory_tracking_v37_trigger
before insert or update on public.products
for each row execute function public.validate_product_inventory_tracking_v37();

-- Append track_inventory to the existing view so existing column positions stay
-- compatible with dependencies and older clients.
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
  case when coalesce(p.avg_cost, 0) <= 0 then 0
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
  (coalesce(p.track_inventory, true) and coalesce(s.sellable_qty, 0) <= coalesce(p.min_stock_level, 1)) as is_low_stock,
  p.warranty_months,
  p.serial_required,
  p.track_inventory
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id;

grant select on public.product_stock_view to authenticated;

-- Preserve the mature accounting implementation. The wrapper temporarily gives
-- non-stock lines enough internal quantity for the legacy function, then restores
-- their exact stock state and removes its stock audit rows. The invoice and its
-- accounting remain unchanged.
do $$
begin
  if to_regprocedure('public.save_pos_invoice_stock_v37(jsonb,jsonb,jsonb)') is null then
    alter function public.save_pos_invoice(jsonb, jsonb, jsonb) rename to save_pos_invoice_stock_v37;
  end if;
end $$;

create or replace function public.save_pos_invoice(
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
  saved_stock jsonb := '[]'::jsonb;
  stock_item record;
  result jsonb;
  doc_id uuid;
begin
  insert into public.stock_balances(product_id)
  select distinct (x.value ->> 'product_id')::uuid
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid
  where not coalesce(p.track_inventory, true)
  on conflict(product_id) do nothing;

  perform 1
  from public.stock_balances sb
  join public.products p on p.id = sb.product_id
  where not coalesce(p.track_inventory, true)
    and sb.product_id in (
      select nullif(x.value ->> 'product_id', '')::uuid
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    )
  for update of sb;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', sb.product_id,
    'sellable_qty', sb.sellable_qty,
    'reserved_qty', sb.reserved_qty,
    'in_transit_qty', sb.in_transit_qty,
    'damaged_qty', sb.damaged_qty,
    'checking_qty', sb.checking_qty
  )), '[]'::jsonb)
  into saved_stock
  from public.stock_balances sb
  join public.products p on p.id = sb.product_id
  where not coalesce(p.track_inventory, true)
    and sb.product_id in (
      select nullif(x.value ->> 'product_id', '')::uuid
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    );

  for stock_item in
    select
      (x.value ->> 'product_id')::uuid as product_id,
      sum(greatest(coalesce((x.value ->> 'qty')::numeric, 0), 0)) as positive_qty
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid
    where not coalesce(p.track_inventory, true)
    group by (x.value ->> 'product_id')::uuid
  loop
    update public.stock_balances
    set sellable_qty = greatest(coalesce(sellable_qty, 0), coalesce(reserved_qty, 0)) + stock_item.positive_qty
    where product_id = stock_item.product_id;
  end loop;

  result := public.save_pos_invoice_stock_v37(p_header, p_items, p_payments);
  doc_id := nullif(result ->> 'id', '')::uuid;

  update public.stock_balances sb
  set sellable_qty = state.sellable_qty,
      reserved_qty = state.reserved_qty,
      in_transit_qty = state.in_transit_qty,
      damaged_qty = state.damaged_qty,
      checking_qty = state.checking_qty,
      updated_at = now()
  from jsonb_to_recordset(saved_stock) as state(
    product_id uuid, sellable_qty numeric, reserved_qty numeric,
    in_transit_qty numeric, damaged_qty numeric, checking_qty numeric
  )
  where sb.product_id = state.product_id;

  if doc_id is not null then
    delete from public.stock_movements sm
    using public.products p
    where sm.product_id = p.id
      and sm.document_id = doc_id
      and not coalesce(p.track_inventory, true);
  end if;

  return result;
end;
$$;

revoke all on function public.save_pos_invoice(jsonb, jsonb, jsonb) from public;
grant execute on function public.save_pos_invoice(jsonb, jsonb, jsonb) to authenticated;

-- v36 has a special zero-value exchange path which does not call the core
-- function, so the app calls this outer wrapper for every POS invoice.
create or replace function public.save_pos_invoice_v37(
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
  saved_stock jsonb := '[]'::jsonb;
  stock_item record;
  result jsonb;
  doc_id uuid;
begin
  insert into public.stock_balances(product_id)
  select distinct (x.value ->> 'product_id')::uuid
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid
  where not coalesce(p.track_inventory, true)
  on conflict(product_id) do nothing;

  perform 1
  from public.stock_balances sb
  join public.products p on p.id = sb.product_id
  where not coalesce(p.track_inventory, true)
    and sb.product_id in (
      select nullif(x.value ->> 'product_id', '')::uuid
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    )
  for update of sb;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', sb.product_id,
    'sellable_qty', sb.sellable_qty,
    'reserved_qty', sb.reserved_qty,
    'in_transit_qty', sb.in_transit_qty,
    'damaged_qty', sb.damaged_qty,
    'checking_qty', sb.checking_qty
  )), '[]'::jsonb)
  into saved_stock
  from public.stock_balances sb
  join public.products p on p.id = sb.product_id
  where not coalesce(p.track_inventory, true)
    and sb.product_id in (
      select nullif(x.value ->> 'product_id', '')::uuid
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    );

  for stock_item in
    select
      (x.value ->> 'product_id')::uuid as product_id,
      sum(greatest(coalesce((x.value ->> 'qty')::numeric, 0), 0)) as positive_qty
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid
    where not coalesce(p.track_inventory, true)
    group by (x.value ->> 'product_id')::uuid
  loop
    update public.stock_balances
    set sellable_qty = greatest(coalesce(sellable_qty, 0), coalesce(reserved_qty, 0)) + stock_item.positive_qty
    where product_id = stock_item.product_id;
  end loop;

  result := public.save_pos_invoice_v36(p_header, p_items, p_payments);
  doc_id := nullif(result ->> 'id', '')::uuid;

  update public.stock_balances sb
  set sellable_qty = state.sellable_qty,
      reserved_qty = state.reserved_qty,
      in_transit_qty = state.in_transit_qty,
      damaged_qty = state.damaged_qty,
      checking_qty = state.checking_qty,
      updated_at = now()
  from jsonb_to_recordset(saved_stock) as state(
    product_id uuid, sellable_qty numeric, reserved_qty numeric,
    in_transit_qty numeric, damaged_qty numeric, checking_qty numeric
  )
  where sb.product_id = state.product_id;

  if doc_id is not null then
    delete from public.stock_movements sm
    using public.products p
    where sm.product_id = p.id
      and sm.document_id = doc_id
      and not coalesce(p.track_inventory, true);
  end if;

  return result;
end;
$$;

revoke all on function public.save_pos_invoice_v37(jsonb, jsonb, jsonb) from public;
grant execute on function public.save_pos_invoice_v37(jsonb, jsonb, jsonb) to authenticated;

-- COD orders reserve and release physical products only. A stockless service may
-- still be included in the order and later converted to the sales invoice.
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

  for item in
    select di.* from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id and coalesce(p.track_inventory, true)
  loop
    insert into public.stock_balances(product_id) values(item.product_id)
    on conflict(product_id) do nothing;
    update public.stock_balances
    set reserved_qty = greatest(coalesce(reserved_qty, 0) - item.qty, 0), updated_at = now()
    where product_id = item.product_id;
    insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes)
    values(item.product_id, p_document_id, 'release_reserve', -1 * item.qty, item.unit_cost, 'COD order reservation released');
  end loop;

  update public.documents set cod_stock_reserved = false, updated_at = now() where id = p_document_id;
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

  for item in
    select di.* from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id and coalesce(p.track_inventory, true)
  loop
    if coalesce(item.qty, 0) <= 0 then raise exception 'Every COD item must have quantity greater than zero'; end if;
    insert into public.stock_balances(product_id) values(item.product_id)
    on conflict(product_id) do nothing;
    select coalesce(sellable_qty, 0) - coalesce(reserved_qty, 0)
    into available from public.stock_balances where product_id = item.product_id for update;
    if available < item.qty then
      raise exception 'Not enough available stock for %. Available %, requested %', coalesce(item.item_code, item.description), available, item.qty;
    end if;
    update public.stock_balances
    set reserved_qty = coalesce(reserved_qty, 0) + item.qty, updated_at = now()
    where product_id = item.product_id;
    insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes)
    values(item.product_id, p_document_id, 'reserve', item.qty, item.unit_cost, 'Reserved for COD order');
  end loop;

  update public.documents set cod_stock_reserved = true, updated_at = now() where id = p_document_id;
end;
$$;

grant execute on function public.release_cod_reservation_v24(uuid) to authenticated;
grant execute on function public.apply_cod_reservation_v24(uuid) to authenticated;

-- Existing assemblies remain safe if a component is later converted to
-- non-stock: only tracked components limit the buildable quantity.
drop view if exists public.product_assembly_pos_view;
create view public.product_assembly_pos_view
with (security_invoker = true)
as
select
  a.id,
  a.assembly_code,
  a.name,
  a.barcode,
  a.discount_type,
  a.discount_value,
  a.is_active,
  a.created_at,
  a.updated_at,
  coalesce(component_data.components, '[]'::jsonb) as components,
  coalesce(component_data.component_price, 0)::numeric(12,2) as component_price,
  case
    when a.discount_type = 'percent' then round(coalesce(component_data.component_price, 0) * least(a.discount_value, 100) / 100, 2)
    else least(a.discount_value, coalesce(component_data.component_price, 0))
  end::numeric(12,2) as discount_amount,
  case
    when coalesce(component_data.component_price, 0) <= 0 then 0
    when a.discount_type = 'percent' then least(a.discount_value, 100)
    else round(least(a.discount_value, component_data.component_price) / component_data.component_price * 100, 6)
  end::numeric as discount_percent,
  greatest(
    coalesce(component_data.component_price, 0) - case
      when a.discount_type = 'percent' then round(coalesce(component_data.component_price, 0) * least(a.discount_value, 100) / 100, 2)
      else least(a.discount_value, coalesce(component_data.component_price, 0))
    end,
    0
  )::numeric(12,2) as selling_price,
  coalesce(component_data.component_cost, 0)::numeric(12,2) as component_cost,
  coalesce(component_data.buildable_qty, 0)::integer as buildable_qty
from public.product_assemblies a
left join lateral (
  select
    jsonb_agg(jsonb_build_object(
      'product_id', p.id, 'item_code', p.item_code, 'name', p.name, 'qty', ai.qty,
      'selling_price', p.selling_price, 'avg_cost', p.avg_cost,
      'available_qty', case when coalesce(p.track_inventory, true) then greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) else null end,
      'track_inventory', p.track_inventory,
      'is_active', p.is_active
    ) order by ai.sort_order, p.item_code) as components,
    sum(ai.qty * p.selling_price) as component_price,
    sum(ai.qty * p.avg_cost) as component_cost,
    case
      when count(*) filter (where coalesce(p.track_inventory, true)) = 0 then 0
      else min(case when coalesce(p.track_inventory, true) then case when p.is_active then floor(greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) / ai.qty) else 0 end end)
    end as buildable_qty
  from public.product_assembly_items ai
  join public.products p on p.id = ai.product_id
  left join public.stock_balances sb on sb.product_id = p.id
  where ai.assembly_id = a.id
) component_data on true;

grant select on public.product_assembly_pos_view to authenticated;

notify pgrst, 'reload schema';
