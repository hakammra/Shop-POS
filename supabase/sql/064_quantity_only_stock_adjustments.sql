-- v64: Quantity-only stock adjustments.
-- Run once after 063_party_delete_review_reservations.sql.
-- Adjustments preserve product average cost and selling price, create no
-- cashflow, and value inventory gains/losses using the existing average cost.

begin;

create or replace function public.save_stock_adjustment_v64(p_header jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid := gen_random_uuid();
  doc_no text;
  item jsonb;
  product_row public.products%rowtype;
  stock_row public.stock_balances%rowtype;
  bucket_name text;
  qty_change numeric(12,3);
  current_qty numeric(12,3);
  new_qty numeric(12,3);
  existing_avg_cost numeric(12,2);
  total_value numeric(12,2) := 0;
begin
  if not public.has_pos_permission_v38('manage_inventory_documents') then
    raise exception 'Inventory-document permission required';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one stock adjustment item';
  end if;
  if nullif(trim(coalesce(p_header ->> 'notes', '')), '') is null then
    raise exception 'Enter a reason for the stock adjustment';
  end if;

  doc_no := public.next_document_no('stock_adjustment');
  insert into public.documents(
    id, document_no, document_type, status, document_date, total_amount,
    paid_amount, balance_amount, currency, notes, created_by
  ) values (
    doc_id, doc_no, 'stock_adjustment', 'completed',
    coalesce(nullif(p_header ->> 'document_date', '')::date, current_date),
    0, 0, 0, 'LKR', trim(p_header ->> 'notes'), auth.uid()
  );

  for item in select value from jsonb_array_elements(p_items)
  loop
    qty_change := coalesce((item ->> 'qty')::numeric, 0);
    bucket_name := lower(coalesce(nullif(item ->> 'bucket', ''), 'sellable'));
    if qty_change = 0 then continue; end if;
    if bucket_name not in ('sellable', 'damaged', 'checking') then
      raise exception 'Invalid stock bucket: %', bucket_name;
    end if;

    select * into product_row
    from public.products
    where id = (item ->> 'product_id')::uuid
    for update;
    if not found then raise exception 'Product not found: %', item ->> 'product_id'; end if;
    if not coalesce(product_row.track_inventory, true) then
      raise exception '% is a non-stock item and cannot be adjusted', product_row.item_code;
    end if;
    existing_avg_cost := coalesce(product_row.avg_cost, 0);

    insert into public.stock_balances(product_id) values(product_row.id)
    on conflict(product_id) do nothing;
    select * into stock_row
    from public.stock_balances
    where product_id = product_row.id
    for update;

    current_qty := case bucket_name
      when 'sellable' then coalesce(stock_row.sellable_qty, 0)
      when 'damaged' then coalesce(stock_row.damaged_qty, 0)
      else coalesce(stock_row.checking_qty, 0)
    end;
    new_qty := current_qty + qty_change;
    if new_qty < 0 then
      raise exception '% stock cannot go below zero for %. Current %, change %', initcap(bucket_name), product_row.item_code, current_qty, qty_change;
    end if;
    if bucket_name = 'sellable' and new_qty < coalesce(stock_row.reserved_qty, 0) then
      raise exception 'Cannot remove reserved stock for %. Available %, requested reduction %', product_row.item_code, current_qty - coalesce(stock_row.reserved_qty, 0), abs(qty_change);
    end if;

    update public.stock_balances
    set sellable_qty = case when bucket_name = 'sellable' then new_qty else sellable_qty end,
        damaged_qty = case when bucket_name = 'damaged' then new_qty else damaged_qty end,
        checking_qty = case when bucket_name = 'checking' then new_qty else checking_qty end,
        updated_at = now()
    where product_id = product_row.id;

    insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes, created_by)
    values(
      product_row.id, doc_id, 'stock_adjustment', qty_change, existing_avg_cost,
      initcap(bucket_name) || ' stock: ' || trim(p_header ->> 'notes'), auth.uid()
    );

    insert into public.document_items(
      document_id, product_id, item_code, description, qty, unit_price, unit_cost,
      discount_type, discount_value, line_total
    ) values (
      doc_id, product_row.id, product_row.item_code, product_row.name, qty_change,
      0, existing_avg_cost, 'none', 0, round(qty_change * existing_avg_cost, 2)
    );
    total_value := total_value + round(qty_change * existing_avg_cost, 2);
  end loop;

  if not exists(select 1 from public.document_items where document_id = doc_id) then
    raise exception 'Add at least one non-zero stock adjustment item';
  end if;

  update public.documents
  set total_amount = total_value, updated_at = now()
  where id = doc_id;

  return jsonb_build_object(
    'document_id', doc_id,
    'document_no', doc_no,
    'total_value', total_value,
    'average_cost_preserved', true,
    'selling_price_preserved', true
  );
end;
$$;

revoke all on function public.save_stock_adjustment_v64(jsonb, jsonb) from public;
grant execute on function public.save_stock_adjustment_v64(jsonb, jsonb) to authenticated;

insert into public.assistant_pos_guides(topic, area, keywords, content)
values(
  'Correct a physical stock count',
  'Stock',
  array['stock adjustment','physical count','missing stock','theft','extra stock','damaged stock','checking stock'],
  '1. Open Stock and choose Stock adjustment. 2. Search for and add the product. 3. Choose Sellable, Damaged, or Checking. 4. Enter a positive quantity to add or a negative quantity to remove. 5. Enter a clear reason and save. This changes quantities only: it does not create cashflow and does not change the product average cost or selling price. The existing average cost is used internally to record an inventory gain or loss. To move an item between buckets, enter two lines, such as -1 Sellable and +1 Damaged. Do not use an adjustment for a missed sale; record the actual sale instead.'
)
on conflict ((lower(topic))) do update set
  area = excluded.area,
  keywords = excluded.keywords,
  content = excluded.content,
  is_active = true,
  updated_at = now();

notify pgrst, 'reload schema';
commit;
