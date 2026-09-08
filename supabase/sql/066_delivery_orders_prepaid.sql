-- v66: General delivery orders with COD and prepaid sales-invoice workflows.
-- Run once after 065_purchase_cashflow_payment_rules.sql.

begin;

alter table public.documents
  add column if not exists delivery_payment_mode text not null default 'cod';

alter table public.documents drop constraint if exists documents_delivery_payment_mode_check;
alter table public.documents
  add constraint documents_delivery_payment_mode_check
  check (delivery_payment_mode in ('cod', 'prepaid'));

create or replace function public.save_delivery_order_v66(
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
  payment_mode text := lower(coalesce(nullif(p_header ->> 'delivery_payment_mode', ''), 'cod'));
  order_result jsonb;
  invoice_result jsonb;
  order_id uuid;
  order_row public.documents%rowtype;
  payment_row jsonb;
  payment_method public.payment_methods%rowtype;
  payment_total numeric(12,2) := 0;
  first_payment_method_id uuid;
  invoice_header jsonb;
begin
  if payment_mode not in ('cod', 'prepaid') then raise exception 'Choose COD or Prepaid'; end if;

  order_result := public.save_cod_order_v24(
    p_header || case when payment_mode = 'prepaid' then jsonb_build_object('cod_collect_amount', 0) else '{}'::jsonb end,
    p_items
  );
  order_id := (order_result ->> 'id')::uuid;

  if payment_mode = 'cod' then
    update public.documents set delivery_payment_mode = 'cod' where id = order_id;
    return order_result || jsonb_build_object('delivery_payment_mode', 'cod');
  end if;

  select * into order_row from public.documents where id = order_id for update;
  for payment_row in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    select * into payment_method
    from public.payment_methods
    where id = nullif(payment_row ->> 'payment_method_id', '')::uuid and is_active = true;
    if not found or coalesce(payment_method.is_paid_method, false) = false or coalesce(payment_method.affects_cashflow, false) = false then
      raise exception 'Prepaid delivery requires an active paid cashflow payment method';
    end if;
    payment_total := payment_total + greatest(coalesce((payment_row ->> 'amount')::numeric, 0), 0);
    first_payment_method_id := coalesce(first_payment_method_id, payment_method.id);
  end loop;
  if first_payment_method_id is null then raise exception 'Select how the prepaid delivery was paid'; end if;
  if abs(payment_total - order_row.total_amount) > 0.01 then
    raise exception 'Prepaid amount must equal the sales total. Expected %', order_row.total_amount;
  end if;

  -- The temporary reservation prevents another sale taking the units while this
  -- transaction is being prepared. The invoice then performs the real deduction.
  perform public.release_cod_reservation_v24(order_id);
  invoice_header := jsonb_build_object(
    'document_no', '',
    'customer_id', coalesce(order_row.customer_id::text, ''),
    'document_date', coalesce((p_header ->> 'document_date'), current_date::text),
    'cart_discount_type', 'amount',
    'cart_discount_value', 0,
    'notes', concat('Prepaid delivery order ', order_row.document_no,
      case when nullif(trim(coalesce(p_header ->> 'notes', '')), '') is null then '' else E'\n' || trim(p_header ->> 'notes') end)
  );
  invoice_result := public.save_pos_invoice_v56(invoice_header, p_items, p_payments);

  update public.documents
  set delivery_payment_mode = 'prepaid',
      linked_document_id = (invoice_result ->> 'id')::uuid,
      payment_method_id = first_payment_method_id,
      paid_amount = total_amount,
      balance_amount = 0,
      cod_collect_amount = 0,
      cod_received_amount = total_amount,
      delivery_fee_mode = 'paid_on_handover',
      updated_at = now()
  where id = order_id;

  return order_result || jsonb_build_object(
    'delivery_payment_mode', 'prepaid',
    'invoice_id', invoice_result ->> 'id',
    'invoice_no', invoice_result ->> 'document_no'
  );
end;
$$;

create or replace function public.replace_delivery_order_v66(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery_row public.documents%rowtype;
  result jsonb;
begin
  select * into delivery_row from public.documents where id = p_document_id for update;
  if not found or delivery_row.document_type <> 'cod_order' then raise exception 'Delivery order not found'; end if;

  if coalesce(delivery_row.delivery_payment_mode, 'cod') = 'cod' then
    result := public.replace_cod_order_v24(p_document_id, p_header, p_items);
    update public.documents set delivery_payment_mode = 'cod' where id = p_document_id;
    return result || jsonb_build_object('delivery_payment_mode', 'cod');
  end if;

  if delivery_row.status in ('delivered', 'returned', 'cancelled') then
    raise exception 'A completed prepaid delivery cannot be edited';
  end if;
  if nullif(trim(coalesce(p_header ->> 'recipient_name', '')), '') is null then raise exception 'Customer/recipient name is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_phone', '')), '') is null then raise exception 'Customer contact number is required'; end if;
  if nullif(trim(coalesce(p_header ->> 'delivery_address', '')), '') is null then raise exception 'Delivery address is required'; end if;
  update public.documents
  set document_no = coalesce(nullif(trim(coalesce(p_header ->> 'document_no', '')), ''), document_no),
      document_date = coalesce(nullif(p_header ->> 'document_date', '')::date, document_date::date)::timestamptz,
      notes = nullif(trim(coalesce(p_header ->> 'notes', '')), ''),
      order_source = nullif(trim(coalesce(p_header ->> 'order_source', '')), ''),
      recipient_name = trim(p_header ->> 'recipient_name'),
      delivery_phone = trim(p_header ->> 'delivery_phone'),
      delivery_address = trim(p_header ->> 'delivery_address'),
      delivery_service = nullif(trim(coalesce(p_header ->> 'delivery_service', '')), ''),
      tracking_number = nullif(trim(coalesce(p_header ->> 'tracking_number', '')), ''),
      delivery_charge = greatest(coalesce(nullif(p_header ->> 'delivery_charge', '')::numeric, delivery_charge, 0), 0),
      updated_at = now()
  where id = p_document_id;
  return jsonb_build_object('id', p_document_id, 'document_no', delivery_row.document_no, 'delivery_payment_mode', 'prepaid', 'invoice_id', delivery_row.linked_document_id);
end;
$$;

create or replace function public.update_delivery_order_status_v66(
  p_document_id uuid,
  p_status text,
  p_tracking_number text default null,
  p_delivery_service text default null,
  p_payment_method_id uuid default null,
  p_delivery_fee_paid_now numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery_row public.documents%rowtype;
  payment_method public.payment_methods%rowtype;
  fee_now numeric(12,2) := greatest(coalesce(p_delivery_fee_paid_now, 0), 0);
begin
  select * into delivery_row from public.documents where id = p_document_id for update;
  if not found or delivery_row.document_type <> 'cod_order' then raise exception 'Delivery order not found'; end if;
  if coalesce(delivery_row.delivery_payment_mode, 'cod') = 'cod' then
    perform public.update_cod_order_status_v24(p_document_id, p_status, p_tracking_number, p_delivery_service, p_payment_method_id, fee_now);
    return;
  end if;
  if delivery_row.status in ('delivered', 'returned', 'cancelled') then raise exception 'This delivery order is already closed'; end if;
  if p_status not in ('awaiting_packing', 'packed', 'dispatched', 'delivered', 'cancelled') then raise exception 'Unsupported prepaid delivery status: %', p_status; end if;
  if fee_now > 0 then
    select * into payment_method from public.payment_methods where id = p_payment_method_id and is_active and affects_cashflow;
    if not found then raise exception 'Select an active cashflow payment method for the courier fee'; end if;
    insert into public.cashflow_entries(document_id, entry_type, account_name, payment_method_id, amount, description)
    values(p_document_id, 'cash_out', payment_method.name, payment_method.id, fee_now, 'Courier fee for prepaid delivery ' || delivery_row.document_no);
  end if;
  update public.documents
  set status = p_status,
      tracking_number = coalesce(nullif(trim(coalesce(p_tracking_number, '')), ''), tracking_number),
      delivery_service = coalesce(nullif(trim(coalesce(p_delivery_service, '')), ''), delivery_service),
      delivery_charge_paid = coalesce(delivery_charge_paid, 0) + fee_now,
      dispatched_at = case when p_status = 'dispatched' then coalesce(dispatched_at, now()) else dispatched_at end,
      delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
      updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.return_delivery_order_v66(
  p_document_id uuid,
  p_return_reason text default null,
  p_payment_method_id uuid default null,
  p_delivery_fee_charge numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery_row public.documents%rowtype;
  payment_method public.payment_methods%rowtype;
  fee_due numeric(12,2);
begin
  select * into delivery_row from public.documents where id = p_document_id for update;
  if not found or delivery_row.document_type <> 'cod_order' then raise exception 'Delivery order not found'; end if;
  if coalesce(delivery_row.delivery_payment_mode, 'cod') = 'cod' then
    perform public.return_cod_order_v24(p_document_id, p_return_reason, p_payment_method_id, p_delivery_fee_charge);
    return;
  end if;
  if delivery_row.status in ('returned', 'cancelled') then raise exception 'This delivery order is already closed'; end if;
  fee_due := greatest(coalesce(p_delivery_fee_charge, delivery_row.delivery_charge, 0) - coalesce(delivery_row.delivery_charge_paid, 0), 0);
  if fee_due > 0 then
    select * into payment_method from public.payment_methods where id = p_payment_method_id and is_active and affects_cashflow;
    if not found then raise exception 'Select an active cashflow payment method for the return fee'; end if;
    insert into public.cashflow_entries(document_id, entry_type, account_name, payment_method_id, amount, description)
    values(p_document_id, 'cash_out', payment_method.name, payment_method.id, fee_due, 'Returned prepaid delivery charge ' || delivery_row.document_no);
  end if;
  update public.documents
  set status = 'returned', returned_at = now(), return_reason = nullif(trim(coalesce(p_return_reason, '')), ''),
      delivery_charge_paid = coalesce(delivery_charge_paid, 0) + fee_due, updated_at = now()
  where id = p_document_id;
end;
$$;

-- Keep the existing function name because the deployed SLPOST Edge Function
-- also calls it. Prepaid parcels finish at Delivered instead of Awaiting Payment.
create or replace function public.record_cod_tracking_v25(
  p_document_id uuid,
  p_tracking_number text,
  p_courier_status text,
  p_tracking_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery_row public.documents%rowtype;
  next_status text;
  clean_courier_status text := trim(coalesce(p_courier_status, ''));
begin
  select * into delivery_row from public.documents where id = p_document_id for update;
  if not found or delivery_row.document_type <> 'cod_order' then raise exception 'Delivery order not found'; end if;
  if clean_courier_status = '' then raise exception 'Courier status is required'; end if;
  next_status := delivery_row.status;
  if lower(clean_courier_status) in ('delivered', 'settled') and delivery_row.status in ('packed', 'dispatched') then
    next_status := case when coalesce(delivery_row.delivery_payment_mode, 'cod') = 'prepaid' then 'delivered' else 'awaiting_settlement' end;
  end if;
  update public.documents
  set tracking_number = coalesce(nullif(trim(coalesce(p_tracking_number, '')), ''), tracking_number),
      delivery_service = 'SLPOST', courier_status = clean_courier_status,
      courier_status_checked_at = now(), courier_tracking_data = coalesce(p_tracking_payload, '{}'::jsonb),
      status = next_status,
      delivered_at = case when next_status in ('delivered', 'awaiting_settlement') then coalesce(delivered_at, now()) else delivered_at end,
      updated_at = now()
  where id = p_document_id;
  return jsonb_build_object('document_id', p_document_id, 'courier_status', clean_courier_status, 'workflow_status', next_status, 'checked_at', now());
end;
$$;

revoke all on function public.save_delivery_order_v66(jsonb, jsonb, jsonb) from public;
revoke all on function public.replace_delivery_order_v66(uuid, jsonb, jsonb) from public;
revoke all on function public.update_delivery_order_status_v66(uuid, text, text, text, uuid, numeric) from public;
revoke all on function public.return_delivery_order_v66(uuid, text, uuid, numeric) from public;
grant execute on function public.save_delivery_order_v66(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_delivery_order_v66(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.update_delivery_order_status_v66(uuid, text, text, text, uuid, numeric) to authenticated;
grant execute on function public.return_delivery_order_v66(uuid, text, uuid, numeric) to authenticated;
grant execute on function public.record_cod_tracking_v25(uuid, text, text, jsonb) to authenticated;

update public.assistant_pos_guides
set topic = 'Create and process a delivery order', area = 'Delivery Orders',
    keywords = array['delivery','delivery order','cod','cash on delivery','prepaid','courier','dispatch','packing','settlement','placed by'],
    content = '1. Open Delivery Orders and choose New Order. 2. Choose COD when the courier will collect payment, or Prepaid when payment was already received. 3. Enter recipient, phone, delivery address, courier details, and products. A COD order reserves stock and creates its sales invoice only at settlement. A Prepaid order records payment and creates its linked sales invoice immediately. 4. Select the order in the queue to print its address label or bill and move it through packing and dispatch. Prepaid delivery completion never creates a second invoice or payment.' ,
    updated_at = now()
where lower(topic) in ('create and process a cod order', 'create and process a delivery order');

notify pgrst, 'reload schema';
commit;
