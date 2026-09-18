-- v78: POS payment layout, settled walk-in refunds, product-origin markers,
-- and sales-staff Wholesale Catalog refresh.
-- Run once after 077_round_automatic_prices_and_reset_empty_pos_customer.sql.

begin;

alter table public.payment_methods
  add column if not exists display_order integer not null default 100;

alter table public.app_settings
  add column if not exists pos_quick_payment_method_ids jsonb not null default '[]'::jsonb;

-- Give existing methods a useful initial order. Once the Settings screen saves
-- a custom layout, its 10/20/30... values are retained on later re-runs.
do $$
begin
  if not exists(select 1 from public.payment_methods where display_order <> 100) then
    update public.payment_methods
    set display_order = case
      when lower(trim(name)) = 'cash' then 10
      when lower(trim(name)) like 'bank%' then 20
      when lower(trim(name)) like '%card%' then 30
      when lower(trim(name)) like '%cheque%' then 40
      when lower(trim(name)) = 'credit' then 90
      when lower(trim(name)) like '%store credit%' then 95
      else 60
    end;
  end if;
end;
$$;

create or replace function public.admin_save_payment_layout_v78(
  p_order jsonb,
  p_quick_ids jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  admin_id uuid;
  order_item jsonb;
  method_id uuid;
  order_value integer;
  quick_count integer;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff where id = admin_id and role = 'admin' and is_active) then
    raise exception 'Only an active admin can change the payment layout';
  end if;
  if jsonb_typeof(coalesce(p_order, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_quick_ids, '[]'::jsonb)) <> 'array' then
    raise exception 'Payment layout must be an array';
  end if;

  select jsonb_array_length(coalesce(p_quick_ids, '[]'::jsonb)) into quick_count;
  if quick_count > 4 then raise exception 'Choose no more than four POS quick-payment methods'; end if;

  for order_item in select value from jsonb_array_elements(coalesce(p_order, '[]'::jsonb)) loop
    method_id := nullif(order_item ->> 'id', '')::uuid;
    order_value := greatest(0, least(coalesce((order_item ->> 'display_order')::integer, 100), 100000));
    if method_id is not null then
      update public.payment_methods set display_order = order_value where id = method_id;
      if not found then raise exception 'Payment method % was not found', method_id; end if;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_quick_ids, '[]'::jsonb)) q(id)
    left join public.payment_methods pm on pm.id = q.id::uuid
    where pm.id is null or not pm.is_active or lower(pm.name) like '%store credit%'
  ) then
    raise exception 'Every POS quick-payment method must be active and usable';
  end if;

  update public.app_settings
  set pos_quick_payment_method_ids = coalesce(p_quick_ids, '[]'::jsonb),
      updated_at = now()
  where id = true;

  return jsonb_build_object(
    'quick_ids', coalesce(p_quick_ids, '[]'::jsonb),
    'payment_methods', (
      select coalesce(jsonb_agg(to_jsonb(pm) order by pm.display_order, lower(pm.name)), '[]'::jsonb)
      from public.payment_methods pm
    )
  );
end;
$$;

revoke all on function public.admin_save_payment_layout_v78(jsonb, jsonb) from public;
grant execute on function public.admin_save_payment_layout_v78(jsonb, jsonb) to authenticated;

-- The core v20 invoice implementation was retained under this name by SQL 37.
-- Remove only its blanket ban on negative walk-in invoices. Its outstanding
-- delta check still requires the refund to be paid out exactly, and still blocks
-- Credit/non-cash lines or any remaining customer balance.
do $$
declare
  definition text;
  old_rule text := 'if (cust_id is null) and (final_total < 0 or outstanding_delta <> 0 or non_cash_total > 0) then';
  new_rule text := 'if (cust_id is null) and (abs(outstanding_delta) > 0.005 or non_cash_total > 0) then';
begin
  if to_regprocedure('public.save_pos_invoice_stock_v37(jsonb,jsonb,jsonb)') is null then
    raise exception 'SQL 037 invoice function is missing. Run the migrations in order through SQL 077 first.';
  end if;
  select pg_get_functiondef('public.save_pos_invoice_stock_v37(jsonb,jsonb,jsonb)'::regprocedure) into definition;
  if position(old_rule in definition) > 0 then
    execute replace(definition, old_rule, new_rule);
  elsif position(new_rule in definition) = 0 then
    raise exception 'Could not safely update the walk-in refund validation rule';
  end if;
end;
$$;

-- Product searches outside POS use product_stock_view. Append Wholesale link
-- metadata so every picker can apply the same clear source styling.
create or replace view public.product_stock_view
with (security_invoker = true)
as
select
  p.id as product_id, p.item_code, p.name, p.category_id, p.barcode, p.selling_price, p.avg_cost,
  case when coalesce(p.avg_cost,0) <= 0 then 0 else round(((coalesce(p.selling_price,0)-coalesce(p.avg_cost,0))/nullif(p.avg_cost,0))*100,2) end as markup_percent,
  p.min_stock_level, p.online_visible, p.is_active, p.status,
  c.name as category_name, c.path as category_path, c.parent_id as category_parent_id, b.name as brand_name,
  coalesce(s.sellable_qty,0) as sellable_qty, coalesce(s.sellable_qty,0) as quantity,
  coalesce(s.reserved_qty,0) as reserved_qty, coalesce(s.damaged_qty,0) as damaged_qty,
  coalesce(s.checking_qty,0) as checking_qty, coalesce(s.sellable_qty,0)-coalesce(s.reserved_qty,0) as available_qty,
  coalesce(s.in_transit_qty,0) as in_transit_qty,
  coalesce(s.sellable_qty,0)*coalesce(p.avg_cost,0) as total_cost_value,
  coalesce(s.sellable_qty,0)*coalesce(p.selling_price,0) as total_sale_value,
  coalesce(s.in_transit_qty,0)*coalesce(p.avg_cost,0) as in_transit_value,
  (coalesce(p.track_inventory,true) and coalesce(s.sellable_qty,0) <= coalesce(p.min_stock_level,1)) as is_low_stock,
  p.warranty_months, p.serial_required, p.track_inventory,
  p.inventory_ownership, p.consignment_owner_id, p.consignment_unit_payout,
  owner.name as consignment_owner_name,
  (wholesale_link.id is not null) as is_wholesale_linked,
  coalesce(wholesale_link.is_enabled, false) as wholesale_link_enabled,
  wholesale_link.last_synced_at as wholesale_last_synced_at
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id
left join public.customers owner on owner.id = p.consignment_owner_id
left join public.retail_wholesale_product_links wholesale_link on wholesale_link.retail_product_id = p.id;

grant select on public.product_stock_view to authenticated;

-- Viewing fresh Wholesale availability is part of selling, not product editing.
create or replace function public.authorize_retail_wholesale_catalog_v76()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not (
    exists(select 1 from public.staff where id = public.current_pos_staff_id_v38() and role = 'admin' and is_active)
    or public.has_pos_permission_v38('manage_products')
    or public.has_pos_permission_v38('pos_sales')
  ) then
    raise exception 'POS sales or product-management permission required';
  end if;
  return true;
end;
$$;

revoke all on function public.authorize_retail_wholesale_catalog_v76() from public;
grant execute on function public.authorize_retail_wholesale_catalog_v76() to authenticated;

notify pgrst, 'reload schema';
commit;
