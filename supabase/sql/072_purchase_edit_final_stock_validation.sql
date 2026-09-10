-- v72: Validate the final purchase-edit stock position instead of rejecting a
-- valid edit during the temporary old-document reversal.
-- Run once after 071_track_non_cashflow_payment_accounts.sql.

begin;

-- The normal rule remains strict. A negative intermediate quantity is allowed
-- only inside a wrapper which has already locked and validated the final stock.
create or replace function public.adjust_stock_moving_average(
  p_product_id uuid,
  p_delta_qty numeric,
  p_unit_cost numeric,
  p_document_id uuid default null,
  p_notes text default null,
  p_movement_type text default 'stock_adjustment'
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
  internal_reapply boolean := coalesce(current_setting('shop_pos.allow_negative_stock', true), '') = 'on';
begin
  if coalesce(p_delta_qty, 0) = 0 then
    return;
  end if;

  insert into public.stock_balances(product_id)
  values(p_product_id)
  on conflict(product_id) do nothing;

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

  new_qty := old_qty + p_delta_qty;

  if new_qty < 0 and not internal_reapply then
    raise exception 'Cannot edit/reverse document because product stock would become negative. Product %, current qty %, change %', p_product_id, old_qty, p_delta_qty;
  end if;

  if new_qty = 0 then
    new_avg := 0;
  elsif old_qty <= 0 and p_delta_qty > 0 then
    new_avg := round(coalesce(p_unit_cost, old_cost, 0), 2);
  else
    new_avg := round(((old_qty * old_cost) + (p_delta_qty * coalesce(p_unit_cost, 0))) / new_qty, 2);
  end if;

  if new_avg > 0 and old_cost > 0 and old_price > 0 then
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

  insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes)
  values(p_product_id, p_document_id, p_movement_type, p_delta_qty, p_unit_cost, p_notes);
end;
$$;

create or replace function public.replace_purchase_like_document_v72(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  stock_item record;
  previous_negative_setting text := coalesce(current_setting('shop_pos.allow_negative_stock', true), '');
begin
  perform public.validate_cheque_payments_v56(p_payments);

  select id, document_no, document_type, status
  into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found';
  end if;
  if doc.document_type not in ('purchase', 'stock_in_transit') then
    raise exception 'Only Purchase and Stock in Transit editing is supported';
  end if;

  if doc.document_type = 'purchase' then
    insert into public.stock_balances(product_id)
    select distinct product_id
    from (
      select di.product_id
      from public.document_items di
      where di.document_id = p_document_id
      union all
      select nullif(line.value ->> 'product_id', '')::uuid
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) line
    ) affected
    where product_id is not null
    on conflict(product_id) do nothing;

    -- These row locks make validation and reapply atomic against sales and
    -- other stock changes. Final stock must still cover every reservation.
    for stock_item in
      with old_lines as (
        select di.product_id, sum(di.qty)::numeric as qty
        from public.document_items di
        where di.document_id = p_document_id
          and doc.status = 'completed'
        group by di.product_id
      ),
      new_lines as (
        select
          nullif(line.value ->> 'product_id', '')::uuid as product_id,
          sum(coalesce(nullif(line.value ->> 'qty', '')::numeric, 0))::numeric as qty
        from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) line
        group by nullif(line.value ->> 'product_id', '')::uuid
      ),
      affected as (
        select coalesce(old_lines.product_id, new_lines.product_id) as product_id,
               coalesce(old_lines.qty, 0) as old_qty,
               coalesce(new_lines.qty, 0) as new_qty
        from old_lines
        full join new_lines using(product_id)
      )
      select
        affected.product_id,
        p.item_code,
        coalesce(sb.sellable_qty, 0) as current_qty,
        coalesce(sb.reserved_qty, 0) as reserved_qty,
        affected.old_qty,
        affected.new_qty,
        coalesce(sb.sellable_qty, 0) - affected.old_qty + affected.new_qty as final_qty
      from affected
      join public.products p on p.id = affected.product_id
      join public.stock_balances sb on sb.product_id = affected.product_id
      order by affected.product_id
      for update of sb, p
    loop
      if stock_item.final_qty < stock_item.reserved_qty then
        raise exception 'Cannot edit purchase: product % would finish with % in stock, but % is reserved. Increase the edited quantity or release reservations first.',
          stock_item.item_code, stock_item.final_qty, stock_item.reserved_qty;
      end if;
    end loop;

    perform set_config('shop_pos.allow_negative_stock', 'on', true);
  end if;

  -- Keep the established reverse-and-reapply path for moving-average cost,
  -- supplier balance, payments, account entries and stock movements.
  perform public.replace_purchase_like_document_v18(p_document_id, p_header, p_items, p_payments);
  perform set_config('shop_pos.allow_negative_stock', previous_negative_setting, true);

  delete from public.cheque_payments where document_id = p_document_id;
  perform public.record_cheque_payments_v56(p_document_id, p_payments, 'out');
end;
$$;

revoke all on function public.replace_purchase_like_document_v72(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.replace_purchase_like_document_v72(uuid, jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
