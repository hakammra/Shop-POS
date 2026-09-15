-- v75: Safely correct customer/supplier payment documents.
-- Run once after 074_inventory_conditions_reservations_consignment_dashboard.sql.

begin;

create or replace function public.replace_party_payment_v75(
  p_document_id uuid,
  p_payment_method_id uuid,
  p_amount numeric,
  p_direction text,
  p_note text default null,
  p_cheque_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_document public.documents%rowtype;
  old_flow public.cashflow_entries%rowtype;
  payment_method public.payment_methods%rowtype;
  flow_count integer;
  locked_cheque_count integer;
  old_delta numeric(12,2);
  new_delta numeric(12,2);
  new_outstanding numeric(12,2);
  clean_direction text := lower(trim(coalesce(p_direction, '')));
  payments jsonb;
  target_register_shift_id uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('manage_parties') then
    raise exception 'Manage Parties permission required';
  end if;
  if p_document_id is null then raise exception 'Payment document is required'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if clean_direction not in ('in', 'out') then raise exception 'Payment direction must be in or out'; end if;

  select * into payment_document
  from public.documents
  where id = p_document_id
  for update;

  if not found then raise exception 'Payment document not found'; end if;
  if payment_document.document_type not in ('customer_payment', 'supplier_payment') then
    raise exception 'Only customer and supplier payment documents can use this correction';
  end if;
  if payment_document.customer_id is null then
    raise exception 'This payment is not linked to a customer/supplier profile';
  end if;

  select count(*) into flow_count
  from public.cashflow_entries
  where document_id = p_document_id
    and entry_type in ('cash_in', 'cash_out');
  if flow_count <> 1 then
    raise exception 'Payment correction requires exactly one linked payment-account movement. Run SQL 071 first for older payments';
  end if;

  select * into old_flow
  from public.cashflow_entries
  where document_id = p_document_id
    and entry_type in ('cash_in', 'cash_out')
  order by created_at, id
  limit 1
  for update;

  select * into payment_method
  from public.payment_methods
  where id = p_payment_method_id
    and coalesce(is_paid_method, true);
  if not found then raise exception 'Select a paid payment method'; end if;
  if not coalesce(payment_method.is_active, true) and payment_method.id is distinct from old_flow.payment_method_id then
    raise exception 'The selected payment method is inactive';
  end if;

  select count(*) into locked_cheque_count
  from public.cheque_payments
  where document_id = p_document_id
    and status not in ('received', 'issued');
  if locked_cheque_count > 0 then
    raise exception 'A deposited, cleared, bounced or cancelled cheque cannot be changed from the payment editor';
  end if;

  payments := jsonb_build_array(jsonb_build_object(
    'source_line_id', coalesce(nullif(p_cheque_details ->> 'source_line_id', ''), gen_random_uuid()::text),
    'payment_method_id', payment_method.id,
    'amount', round(p_amount, 2),
    'direction', clean_direction,
    'cheque_number', p_cheque_details ->> 'cheque_number',
    'cheque_date', p_cheque_details ->> 'cheque_date',
    'cheque_bank_name', p_cheque_details ->> 'cheque_bank_name'
  ));
  perform public.validate_cheque_payments_v56(payments);

  -- Payment documents use a positive balance delta for money paid out and a
  -- negative delta for money received. Reverse the old effect before applying
  -- the corrected one, all inside this transaction.
  old_delta := case when old_flow.entry_type = 'cash_out' then old_flow.amount else -old_flow.amount end;
  new_delta := case when clean_direction = 'out' then round(p_amount, 2) else -round(p_amount, 2) end;
  perform public.apply_customer_outstanding_delta(payment_document.customer_id, -old_delta);
  new_outstanding := public.apply_customer_outstanding_delta(payment_document.customer_id, new_delta);

  if coalesce(payment_method.affects_cashflow, false) then
    target_register_shift_id := old_flow.register_shift_id;
    if target_register_shift_id is null then
      select rs.id into target_register_shift_id
      from public.register_shifts rs
      where rs.device_id = public.current_pos_device_id_v56()
        and rs.status = 'open'
      order by rs.opened_at desc
      limit 1;
    end if;
  else
    target_register_shift_id := null;
  end if;

  update public.documents
  set total_amount = round(p_amount, 2),
      paid_amount = round(p_amount, 2),
      balance_amount = 0,
      payment_method_id = payment_method.id,
      notes = coalesce(nullif(trim(p_note), ''), notes),
      updated_at = now()
  where id = p_document_id;

  update public.cashflow_entries
  set entry_type = case when clean_direction = 'out' then 'cash_out' else 'cash_in' end,
      account_name = payment_method.name,
      payment_method_id = payment_method.id,
      amount = round(p_amount, 2),
      description = case when payment_document.document_type = 'supplier_payment'
        then 'Supplier payment document '
        else 'Customer payment document '
      end || payment_document.document_no,
      register_shift_id = target_register_shift_id
  where id = old_flow.id;

  delete from public.cheque_payments where document_id = p_document_id;
  perform public.record_cheque_payments_v56(p_document_id, payments, clean_direction);

  return jsonb_build_object(
    'document_id', p_document_id,
    'document_no', payment_document.document_no,
    'document_type', payment_document.document_type,
    'new_outstanding', new_outstanding,
    'payment_method', payment_method.name,
    'direction', clean_direction,
    'amount', round(p_amount, 2)
  );
end;
$$;

revoke all on function public.replace_party_payment_v75(uuid, uuid, numeric, text, text, jsonb) from public;
grant execute on function public.replace_party_payment_v75(uuid, uuid, numeric, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
