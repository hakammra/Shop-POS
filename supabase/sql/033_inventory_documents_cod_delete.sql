-- v33: Inventory Documents workspace support, stock adjustments, and safe COD deletion.
-- Run once after 032_jobs_workflow.sql.

create or replace function public.delete_cod_order_v33(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc public.documents%rowtype;
  flow_count integer;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Only COD orders can be deleted here'; end if;
  if doc.status = 'converted' or doc.linked_document_id is not null then
    raise exception 'This COD order has already become a sales invoice and cannot be deleted';
  end if;

  select count(*) into flow_count from public.cashflow_entries where document_id = p_document_id;
  if flow_count > 0 then
    raise exception 'This COD order has accounting entries and cannot be deleted. Keep it as cancelled or returned for audit history';
  end if;

  if coalesce(doc.cod_stock_reserved, false) then
    perform public.release_cod_reservation_v24(p_document_id);
  end if;

  -- The order itself is being removed, so its reserve/release audit rows are no longer needed.
  delete from public.stock_movements where document_id = p_document_id;
  delete from public.documents where id = p_document_id;

  return jsonb_build_object('deleted', true, 'document_no', doc.document_no);
end;
$$;

grant execute on function public.delete_cod_order_v33(uuid) to authenticated;

create or replace function public.save_stock_adjustment_v33(p_header jsonb, p_items jsonb)
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
  bucket_name text;
  qty_change numeric(12,3);
  unit_cost_value numeric(12,2);
  current_qty numeric(12,3);
  total_value numeric(12,2) := 0;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one stock adjustment item';
  end if;

  doc_no := public.next_document_no('stock_adjustment');
  insert into public.documents (
    id, document_no, document_type, status, document_date, total_amount,
    paid_amount, balance_amount, currency, notes, created_by
  ) values (
    doc_id, doc_no, 'stock_adjustment', 'completed',
    coalesce(nullif(p_header ->> 'document_date', '')::date, current_date),
    0, 0, 0, 'LKR', nullif(p_header ->> 'notes', ''), auth.uid()
  );

  for item in select value from jsonb_array_elements(p_items)
  loop
    qty_change := coalesce((item ->> 'qty')::numeric, 0);
    bucket_name := lower(coalesce(nullif(item ->> 'bucket', ''), 'sellable'));
    if qty_change = 0 then continue; end if;
    if bucket_name not in ('sellable', 'damaged', 'checking') then raise exception 'Invalid stock bucket: %', bucket_name; end if;

    select * into product_row from public.products where id = (item ->> 'product_id')::uuid for update;
    if not found then raise exception 'Product not found: %', item ->> 'product_id'; end if;
    unit_cost_value := coalesce((item ->> 'unit_cost')::numeric, product_row.avg_cost, 0);

    insert into public.stock_balances (product_id) values (product_row.id) on conflict (product_id) do nothing;

    if bucket_name = 'sellable' then
      perform public.adjust_stock_moving_average(product_row.id, qty_change, unit_cost_value, doc_id, coalesce(p_header ->> 'notes', 'Stock adjustment'), 'stock_adjustment');
    elsif bucket_name = 'damaged' then
      select damaged_qty into current_qty from public.stock_balances where product_id = product_row.id for update;
      if current_qty + qty_change < 0 then raise exception 'Damaged stock cannot go below zero for %', product_row.item_code; end if;
      update public.stock_balances set damaged_qty = damaged_qty + qty_change, updated_at = now() where product_id = product_row.id;
      insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes, created_by)
      values (product_row.id, doc_id, 'stock_adjustment', qty_change, unit_cost_value, concat('Damaged stock: ', coalesce(p_header ->> 'notes', 'adjustment')), auth.uid());
    else
      select checking_qty into current_qty from public.stock_balances where product_id = product_row.id for update;
      if current_qty + qty_change < 0 then raise exception 'Checking stock cannot go below zero for %', product_row.item_code; end if;
      update public.stock_balances set checking_qty = checking_qty + qty_change, updated_at = now() where product_id = product_row.id;
      insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes, created_by)
      values (product_row.id, doc_id, 'stock_adjustment', qty_change, unit_cost_value, concat('Checking stock: ', coalesce(p_header ->> 'notes', 'adjustment')), auth.uid());
    end if;

    insert into public.document_items (
      document_id, product_id, item_code, description, qty, unit_price, unit_cost,
      discount_type, discount_value, line_total
    ) values (
      doc_id, product_row.id, product_row.item_code, product_row.name, qty_change,
      0, unit_cost_value, 'none', 0, round(qty_change * unit_cost_value, 2)
    );
    total_value := total_value + round(qty_change * unit_cost_value, 2);
  end loop;

  if not exists (select 1 from public.document_items where document_id = doc_id) then
    raise exception 'Add at least one non-zero stock adjustment item';
  end if;

  update public.documents set total_amount = total_value, updated_at = now() where id = doc_id;
  return jsonb_build_object('document_id', doc_id, 'document_no', doc_no, 'total_value', total_value);
end;
$$;

grant execute on function public.save_stock_adjustment_v33(jsonb, jsonb) to authenticated;
notify pgrst, 'reload schema';
