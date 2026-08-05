-- Simplify assembly pricing to component total minus one discount.
-- Also allocate POS cart discounts into saved item lines for accurate profit/refund values.
-- Run after 027_product_assemblies.sql.

alter table public.product_assemblies
  add column if not exists discount_type text not null default 'percent',
  add column if not exists discount_value numeric(12,2) not null default 0;

alter table public.product_assemblies drop constraint if exists product_assemblies_discount_type_check;
alter table public.product_assemblies
  add constraint product_assemblies_discount_type_check check (discount_type in ('amount', 'percent'));

alter table public.product_assemblies drop constraint if exists product_assemblies_discount_value_check;
alter table public.product_assemblies
  add constraint product_assemblies_discount_value_check check (discount_value >= 0);

create or replace function public.next_assembly_code_v28()
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

grant execute on function public.next_assembly_code_v28() to authenticated;

create or replace function public.save_product_assembly_v28(
  p_assembly_id uuid,
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid := p_assembly_id;
  component record;
  clean_code text := upper(trim(coalesce(p_header ->> 'assembly_code', '')));
  clean_name text := trim(coalesce(p_header ->> 'name', ''));
  mode text := coalesce(nullif(p_header ->> 'discount_type', ''), 'percent');
begin
  if clean_name = '' then raise exception 'Assembly name is required'; end if;
  if mode not in ('amount', 'percent') then raise exception 'Unsupported discount type'; end if;
  if coalesce((p_header ->> 'discount_value')::numeric, 0) < 0 then raise exception 'Discount cannot be negative'; end if;
  if mode = 'percent' and coalesce((p_header ->> 'discount_value')::numeric, 0) > 100 then raise exception 'Discount percentage cannot exceed 100'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Add at least one component'; end if;

  if target_id is null then
    if clean_code = '' then clean_code := public.next_assembly_code_v28(); end if;
    insert into public.product_assemblies (
      assembly_code, name, barcode, pricing_mode, fixed_price, assembly_fee,
      discount_type, discount_value, is_active
    ) values (
      clean_code, clean_name, nullif(trim(coalesce(p_header ->> 'barcode', '')), ''),
      'component_sum', 0, 0, mode,
      coalesce((p_header ->> 'discount_value')::numeric, 0),
      coalesce((p_header ->> 'is_active')::boolean, true)
    ) returning id into target_id;
  else
    select assembly_code into clean_code from public.product_assemblies where id = target_id for update;
    if not found then raise exception 'Assembly not found'; end if;
    update public.product_assemblies
    set name = clean_name,
        barcode = nullif(trim(coalesce(p_header ->> 'barcode', '')), ''),
        pricing_mode = 'component_sum', fixed_price = 0, assembly_fee = 0,
        discount_type = mode,
        discount_value = coalesce((p_header ->> 'discount_value')::numeric, 0),
        is_active = coalesce((p_header ->> 'is_active')::boolean, true),
        updated_at = now()
    where id = target_id;
    delete from public.product_assembly_items where assembly_id = target_id;
  end if;

  for component in
    select * from jsonb_to_recordset(p_items) as x(product_id uuid, qty numeric, sort_order integer)
  loop
    if component.product_id is null or coalesce(component.qty, 0) <= 0 then
      raise exception 'Every component needs a product and quantity greater than zero';
    end if;
    insert into public.product_assembly_items (assembly_id, product_id, qty, sort_order)
    values (target_id, component.product_id, component.qty, coalesce(component.sort_order, 0));
  end loop;

  return jsonb_build_object('id', target_id, 'assembly_code', clean_code);
end;
$$;

grant execute on function public.save_product_assembly_v28(uuid, jsonb, jsonb) to authenticated;

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
      'available_qty', greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0),
      'is_active', p.is_active
    ) order by ai.sort_order, p.item_code) as components,
    sum(ai.qty * p.selling_price) as component_price,
    sum(ai.qty * p.avg_cost) as component_cost,
    min(case when p.is_active then floor(greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) / ai.qty) else 0 end) as buildable_qty
  from public.product_assembly_items ai
  join public.products p on p.id = ai.product_id
  left join public.stock_balances sb on sb.product_id = p.id
  where ai.assembly_id = a.id
) component_data on true;

grant select on public.product_assembly_pos_view to authenticated;

create or replace function public.allocate_pos_cart_discount_v28(
  p_document_id uuid,
  p_header jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  raw_total numeric := 0;
  cart_discount numeric := 0;
  target_total numeric := 0;
  remaining_total numeric := 0;
  desired_line_total numeric := 0;
  combined_discount numeric := 0;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found or doc.document_type <> 'invoice' then raise exception 'POS invoice not found'; end if;

  select coalesce(sum(line_total), 0) into raw_total from public.document_items where document_id = p_document_id;
  if raw_total = 0 then return; end if;

  if coalesce(p_header ->> 'cart_discount_type', 'amount') = 'percent' then
    cart_discount := round(abs(raw_total) * coalesce(nullif(p_header ->> 'cart_discount_value', '')::numeric, 0) / 100, 2);
  else
    cart_discount := abs(coalesce(nullif(p_header ->> 'cart_discount_value', '')::numeric, 0));
  end if;
  if cart_discount = 0 then return; end if;

  target_total := doc.total_amount;
  remaining_total := target_total;
  for item in
    select di.*, row_number() over (order by di.created_at, di.id) as row_no,
           count(*) over () as row_count
    from public.document_items di
    where di.document_id = p_document_id
    order by di.created_at, di.id
  loop
    if item.row_no = item.row_count then
      desired_line_total := remaining_total;
    else
      desired_line_total := round(item.line_total * target_total / raw_total, 2);
    end if;
    combined_discount := greatest(round(abs(item.qty * item.unit_price) - abs(desired_line_total), 2), 0);
    update public.document_items
    set discount_type = case when combined_discount = 0 then 'none' else 'amount' end,
        discount_value = combined_discount,
        line_total = desired_line_total
    where id = item.id;
    remaining_total := round(remaining_total - desired_line_total, 2);
  end loop;
end;
$$;

create or replace function public.save_pos_invoice_v28(
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
  result jsonb;
begin
  result := public.save_pos_invoice(p_header, p_items, p_payments);
  perform public.allocate_pos_cart_discount_v28((result ->> 'id')::uuid, p_header);
  return result;
end;
$$;

revoke all on function public.allocate_pos_cart_discount_v28(uuid, jsonb) from public;
grant execute on function public.save_pos_invoice_v28(jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
