-- Run in Retail Supabase after 084_pending_wholesale_transfer_cancellation.sql.
-- Transfers can use any active paid payment account, including accounts that
-- are excluded from operational cashflow. Credit is not a money account.

begin;

create or replace function public.save_cash_account_transfer_v43(
  p_from_payment_method_id uuid,
  p_to_payment_method_id uuid,
  p_amount numeric,
  p_description text default null,
  p_transfer_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_method public.payment_methods%rowtype;
  destination_method public.payment_methods%rowtype;
  document_id uuid;
  document_no text;
  clean_description text;
  transfer_amount numeric(12,2);
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('manage_cashflow') then raise exception 'Cashflow permission required'; end if;
  if p_from_payment_method_id is null or p_to_payment_method_id is null then raise exception 'Select both transfer accounts'; end if;
  if p_from_payment_method_id = p_to_payment_method_id then raise exception 'Source and destination accounts must be different'; end if;

  transfer_amount := round(coalesce(p_amount, 0), 2);
  if transfer_amount <= 0 then raise exception 'Transfer amount must be greater than zero'; end if;

  select * into source_method from public.payment_methods
  where id = p_from_payment_method_id and is_active and coalesce(is_paid_method, true);
  if not found then raise exception 'Source paid payment account is unavailable'; end if;

  select * into destination_method from public.payment_methods
  where id = p_to_payment_method_id and is_active and coalesce(is_paid_method, true);
  if not found then raise exception 'Destination paid payment account is unavailable'; end if;

  document_no := public.next_document_no('account_transfer');
  clean_description := coalesce(
    nullif(trim(coalesce(p_description, '')), ''),
    'Transfer from ' || source_method.name || ' to ' || destination_method.name
  );

  insert into public.documents(
    document_no, document_type, status, total_amount, paid_amount,
    balance_amount, currency, document_date, notes
  ) values (
    document_no, 'account_transfer', 'completed', 0, 0,
    0, 'LKR', coalesce(p_transfer_date, current_date)::timestamptz, clean_description
  ) returning id into document_id;

  -- These paired rows drive each payment-account balance/history. Operational
  -- Cash In/Out and income/expense reports exclude account_transfer documents.
  insert into public.cashflow_entries(
    document_id, entry_type, account_name, payment_method_id, amount, description
  ) values
    (document_id, 'cash_out', source_method.name, source_method.id, transfer_amount, clean_description),
    (document_id, 'cash_in', destination_method.name, destination_method.id, transfer_amount, clean_description);

  return jsonb_build_object(
    'document_id', document_id,
    'document_no', document_no,
    'from_account', source_method.name,
    'to_account', destination_method.name,
    'amount', transfer_amount
  );
end;
$$;

revoke all on function public.save_cash_account_transfer_v43(uuid, uuid, numeric, text, date) from public;
grant execute on function public.save_cash_account_transfer_v43(uuid, uuid, numeric, text, date) to authenticated;

notify pgrst, 'reload schema';

commit;
