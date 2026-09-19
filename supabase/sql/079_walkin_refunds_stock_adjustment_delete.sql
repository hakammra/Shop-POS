-- v79: allow a fully settled walk-in refund and safely delete stock adjustments.
-- Run once after 078_pos_payment_layout_walkin_refunds.sql.

begin;

-- SQL 31 rejected every negative walk-in document before the payment function
-- could save it. A walk-in is only unsafe when a balance remains. The POS save
-- function separately validates that an immediate refund is paid out exactly
-- and that no Credit/non-paid method is used.
create or replace function public.validate_document_party_v31()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('shop_pos.restore_mode', true) = 'on' then return new; end if;

  if new.document_type in ('purchase', 'stock_in_transit')
     and new.supplier_id is null and new.customer_id is null then
    raise exception 'Select a supplier/customer profile before saving this purchase';
  end if;

  if new.document_type in ('invoice', 'refund')
     and new.customer_id is null
     and abs(coalesce(new.balance_amount, 0)) > 0.005 then
    raise exception 'Walk-in customer cannot be used when credit or a balance remains';
  end if;

  return new;
end;
$$;

create or replace function public.delete_stock_adjustment_v79(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc public.documents%rowtype;
  adjustment record;
  stock_row public.stock_balances%rowtype;
  next_qty numeric(12,3);
  movement_count integer;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if not public.has_pos_permission_v38('delete_documents') then
    raise exception 'Document deletion permission required';
  end if;

  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then raise exception 'Stock adjustment not found'; end if;
  if doc.document_type <> 'stock_adjustment' then
    raise exception 'Only a Stock Adjustment can be deleted here';
  end if;

  select count(*) into movement_count
  from public.stock_movements
  where document_id = p_document_id
    and movement_type = 'stock_adjustment';

  if movement_count = 0 then
    raise exception 'This adjustment has no linked stock movements and cannot be reversed safely';
  end if;

  -- Net movements by product and bucket first. This safely handles documents
  -- containing more than one line for the same product/bucket.
  for adjustment in
    select
      sm.product_id,
      p.item_code,
      case
        when lower(coalesce(sm.notes, '')) like 'damaged stock:%' then 'damaged'
        when lower(coalesce(sm.notes, '')) like 'checking stock:%' then 'checking'
        else 'sellable'
      end as bucket_name,
      sum(sm.qty)::numeric(12,3) as qty_change
    from public.stock_movements sm
    join public.products p on p.id = sm.product_id
    where sm.document_id = p_document_id
      and sm.movement_type = 'stock_adjustment'
    group by sm.product_id, p.item_code,
      case
        when lower(coalesce(sm.notes, '')) like 'damaged stock:%' then 'damaged'
        when lower(coalesce(sm.notes, '')) like 'checking stock:%' then 'checking'
        else 'sellable'
      end
    order by sm.product_id
  loop
    select * into stock_row
    from public.stock_balances
    where product_id = adjustment.product_id
    for update;

    if not found then
      raise exception 'Stock balance is missing for %', adjustment.item_code;
    end if;

    next_qty := case adjustment.bucket_name
      when 'sellable' then coalesce(stock_row.sellable_qty, 0) - adjustment.qty_change
      when 'damaged' then coalesce(stock_row.damaged_qty, 0) - adjustment.qty_change
      else coalesce(stock_row.checking_qty, 0) - adjustment.qty_change
    end;

    if next_qty < 0 then
      raise exception 'Cannot delete %. Reversal would make % stock negative for %',
        doc.document_no, adjustment.bucket_name, adjustment.item_code;
    end if;
    if adjustment.bucket_name = 'sellable'
       and next_qty < coalesce(stock_row.reserved_qty, 0) then
      raise exception 'Cannot delete %. Reversal would remove reserved stock for %',
        doc.document_no, adjustment.item_code;
    end if;

    update public.stock_balances
    set sellable_qty = case when adjustment.bucket_name = 'sellable' then next_qty else sellable_qty end,
        damaged_qty = case when adjustment.bucket_name = 'damaged' then next_qty else damaged_qty end,
        checking_qty = case when adjustment.bucket_name = 'checking' then next_qty else checking_qty end,
        updated_at = now()
    where product_id = adjustment.product_id;
  end loop;

  -- Adjustments should not have payments, but remove any legacy linked rows so
  -- deletion leaves no orphan financial activity. Document deletion also clears
  -- its automatic accounting entry through the existing accounting trigger.
  delete from public.cashflow_entries where document_id = p_document_id;
  delete from public.stock_movements where document_id = p_document_id;
  delete from public.documents where id = p_document_id;

  return jsonb_build_object(
    'deleted', true,
    'document_id', p_document_id,
    'document_no', doc.document_no,
    'stock_reversed', true
  );
end;
$$;

revoke all on function public.delete_stock_adjustment_v79(uuid) from public;
grant execute on function public.delete_stock_adjustment_v79(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
