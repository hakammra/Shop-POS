-- v10: document tab persistence + full edit/reapply for Purchase and Stock in Transit.
-- Run once after 008/009 updates.

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
begin
  if coalesce(p_delta_qty, 0) = 0 then
    return;
  end if;

  insert into public.stock_balances (product_id)
  values (p_product_id)
  on conflict (product_id) do nothing;

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

  if new_qty < 0 then
    raise exception 'Cannot edit/reverse document because product stock would become negative. Product %, current qty %, change %', p_product_id, old_qty, p_delta_qty;
  end if;

  if new_qty = 0 then
    -- If no stock remains, reset moving-average cost. Selling price is kept.
    new_avg := 0;
  elsif old_qty <= 0 and p_delta_qty > 0 then
    new_avg := round(coalesce(p_unit_cost, old_cost, 0), 2);
  else
    new_avg := round(((old_qty * old_cost) + (p_delta_qty * coalesce(p_unit_cost, 0))) / new_qty, 2);
  end if;

  -- Preserve current markup when avg cost changes. If avg becomes 0, keep old selling price.
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

  insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
  values (p_product_id, p_document_id, p_movement_type, p_delta_qty, p_unit_cost, p_notes);
end;
$$;

create or replace function public.reverse_purchase_like_document(p_document_id uuid)
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

  if doc.document_type not in ('purchase', 'stock_in_transit') then
    raise exception 'Only Purchase and Stock in Transit documents can be re-applied by this function';
  end if;

  if doc.document_type = 'stock_in_transit' and doc.status = 'converted' then
    raise exception 'Converted Stock in Transit documents cannot be edited here. Edit the created Purchase document instead.';
  end if;

  if doc.document_type = 'purchase' and doc.status = 'completed' then
    for item in select * from public.document_items where document_id = p_document_id loop
      perform public.adjust_stock_moving_average(
        item.product_id,
        -1 * item.qty,
        item.unit_cost,
        p_document_id,
        'Reversed old purchase line before document edit',
        'stock_adjustment'
      );
    end loop;
  elsif doc.document_type = 'stock_in_transit' and doc.status = 'in_transit' then
    for item in select * from public.document_items where document_id = p_document_id loop
      insert into public.stock_balances (product_id)
      values (item.product_id)
      on conflict (product_id) do nothing;

      update public.stock_balances
      set in_transit_qty = greatest(coalesce(in_transit_qty, 0) - item.qty, 0),
          updated_at = now()
      where product_id = item.product_id;

      insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
      values (item.product_id, p_document_id, 'stock_adjustment', -1 * item.qty, item.unit_cost, 'Reversed old stock-in-transit line before document edit');
    end loop;
  end if;

  update public.documents
  set status = 'draft',
      updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.replace_purchase_like_document(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  total numeric(12,2) := 0;
  paid numeric(12,2) := 0;
  method_name text;
  pm_id uuid;
  is_credit boolean := false;
begin
  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found';
  end if;

  if doc.document_type not in ('purchase', 'stock_in_transit') then
    raise exception 'Only Purchase and Stock in Transit editing is supported now';
  end if;

  perform public.reverse_purchase_like_document(p_document_id);

  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.document_items where document_id = p_document_id;

  for item in
    select *
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_cost numeric
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) <= 0 then
      raise exception 'Every item must have a product and quantity greater than zero';
    end if;

    insert into public.document_items (
      document_id, product_id, item_code, description, qty, unit_cost, unit_price, line_total
    ) values (
      p_document_id,
      item.product_id,
      item.item_code,
      item.description,
      item.qty,
      coalesce(item.unit_cost, 0),
      coalesce(item.unit_cost, 0),
      round(item.qty * coalesce(item.unit_cost, 0), 2)
    );

    total := total + round(item.qty * coalesce(item.unit_cost, 0), 2);
  end loop;

  if total <= 0 then
    raise exception 'Document total must be greater than zero';
  end if;

  pm_id := nullif(p_header ->> 'payment_method_id', '')::uuid;

  if pm_id is not null then
    select lower(name) into method_name from public.payment_methods where id = pm_id;
    is_credit := method_name = 'credit';
  end if;

  if is_credit then
    paid := 0;
  else
    paid := least(coalesce(nullif(p_header ->> 'paid_amount', '')::numeric, 0), total);
  end if;

  update public.documents
  set document_no = coalesce(nullif(p_header ->> 'document_no', ''), document_no),
      external_document_no = nullif(p_header ->> 'external_document_no', ''),
      supplier_id = nullif(p_header ->> 'supplier_id', '')::uuid,
      payment_method_id = pm_id,
      document_date = coalesce(nullif(p_header ->> 'document_date', '')::date, current_date)::timestamptz,
      shipping_method = nullif(p_header ->> 'shipping_method', ''),
      expected_arrival_date = nullif(p_header ->> 'expected_arrival_date', '')::date,
      notes = nullif(p_header ->> 'notes', ''),
      total_amount = total,
      paid_amount = paid,
      balance_amount = total - paid,
      currency = 'LKR',
      status = 'draft',
      updated_at = now()
  where id = p_document_id;

  if paid > 0 then
    insert into public.cashflow_entries (
      document_id, entry_type, account_name, payment_method_id, amount, description
    ) values (
      p_document_id,
      'cash_out',
      coalesce((select name from public.payment_methods where id = pm_id), 'Cash Drawer'),
      pm_id,
      paid,
      concat('Edited ', doc.document_type, ' payment ', coalesce(p_header ->> 'document_no', doc.document_no))
    );
  end if;

  if doc.document_type = 'purchase' then
    perform public.post_purchase_document(p_document_id);
  else
    perform public.post_stock_in_transit_document(p_document_id);
  end if;
end;
$$;

grant execute on function public.adjust_stock_moving_average(uuid, numeric, numeric, uuid, text, text) to authenticated;
grant execute on function public.reverse_purchase_like_document(uuid) to authenticated;
grant execute on function public.replace_purchase_like_document(uuid, jsonb, jsonb) to authenticated;
