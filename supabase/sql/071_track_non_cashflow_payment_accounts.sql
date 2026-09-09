-- v71: Retain opted-out payment movements for account balances while excluding
-- them from operational cashflow and the daily cash register.
-- Run once after 070_all_payment_account_balances.sql.

begin;

-- SQL 69 originally skipped the ledger row completely. Keep the row for the
-- payment-account balance, but never attach it to a physical register shift.
create or replace function public.enforce_payment_method_cashflow_v69()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  method_affects_cashflow boolean;
begin
  if new.entry_type not in ('cash_in', 'cash_out') or new.payment_method_id is null then
    return new;
  end if;

  select pm.affects_cashflow
  into method_affects_cashflow
  from public.payment_methods pm
  where pm.id = new.payment_method_id;

  if found and coalesce(method_affects_cashflow, false) = false then
    new.register_shift_id := null;
  end if;

  return new;
end;
$$;

-- Purchases previously deleted the opted-out row after posting. Retain it so
-- its bank/other payment account still has a running balance.
create or replace function public.save_purchase_like_document_v65(
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
  saved_document_id uuid;
begin
  perform public.validate_cheque_payments_v56(p_payments);
  result := public.save_purchase_like_document_v18(p_header, p_items, p_payments);
  saved_document_id := (result ->> 'id')::uuid;
  perform public.record_cheque_payments_v56(saved_document_id, p_payments, 'out');
  return result;
end;
$$;

create or replace function public.replace_purchase_like_document_v65(
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
begin
  perform public.validate_cheque_payments_v56(p_payments);
  perform public.replace_purchase_like_document_v18(p_document_id, p_header, p_items, p_payments);
  delete from public.cheque_payments where document_id = p_document_id;
  perform public.record_cheque_payments_v56(p_document_id, p_payments, 'out');
end;
$$;

-- Detach any older opted-out entries from a register before totals are rebuilt.
update public.cashflow_entries cf
set register_shift_id = null
from public.payment_methods pm
where cf.payment_method_id = pm.id
  and cf.entry_type in ('cash_in', 'cash_out')
  and coalesce(pm.affects_cashflow, false) = false
  and cf.register_shift_id is not null;

-- SQL 65/69 may already have removed a paid row. Restore the recoverable amount
-- from the document's primary method. For split payments, existing paid rows are
-- subtracted first so the same money is not counted twice.
with recoverable as (
  select
    d.id as document_id,
    d.document_no,
    d.document_type,
    d.payment_method_id,
    pm.name as payment_method_name,
    case
      when d.document_type in ('purchase', 'stock_in_transit', 'expense') then 'cash_out'
      when d.document_type = 'supplier_payment' and coalesce(d.notes, '') ilike '%refund%' then 'cash_in'
      when d.document_type = 'supplier_payment' then 'cash_out'
      when d.document_type = 'customer_payment' and coalesce(d.notes, '') ilike '%refund%' then 'cash_out'
      when d.document_type = 'customer_payment' then 'cash_in'
      when d.document_type in ('invoice', 'refund') and coalesce(d.total_amount, 0) < 0 then 'cash_out'
      else 'cash_in'
    end as entry_type,
    round(greatest(
      abs(coalesce(d.paid_amount, 0)) - coalesce((
        select sum(existing.amount)
        from public.cashflow_entries existing
        where existing.document_id = d.id
          and existing.entry_type in ('cash_in', 'cash_out')
      ), 0),
      0
    ), 2) as missing_amount
  from public.documents d
  join public.payment_methods pm on pm.id = d.payment_method_id
  where coalesce(pm.is_paid_method, true)
    and coalesce(pm.affects_cashflow, false) = false
    and d.document_type in (
      'invoice', 'refund', 'purchase', 'stock_in_transit',
      'customer_payment', 'supplier_payment', 'expense', 'other_income'
    )
    and not exists (
      select 1 from public.cashflow_entries same_method
      where same_method.document_id = d.id
        and same_method.payment_method_id = d.payment_method_id
        and same_method.entry_type in ('cash_in', 'cash_out')
    )
)
insert into public.cashflow_entries(
  document_id, entry_type, account_name, payment_method_id, amount, description
)
select
  document_id,
  entry_type,
  payment_method_name,
  payment_method_id,
  missing_amount,
  'Payment account movement restored for ' || document_no
from recoverable
where missing_amount > 0.004;

-- Recalculate already-closed drawers without opted-out payment movements.
update public.register_shifts rs
set expected_cash = round(rs.opening_cash + coalesce((
      select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
      from public.cashflow_entries cf
      join public.payment_methods pm on pm.id = cf.payment_method_id
      where cf.register_shift_id = rs.id
        and pm.account_kind = 'cash'
        and coalesce(pm.affects_cashflow, false)
    ), 0), 2),
    variance = case when rs.counted_cash is null then null else round(rs.counted_cash - (rs.opening_cash + coalesce((
      select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
      from public.cashflow_entries cf
      join public.payment_methods pm on pm.id = cf.payment_method_id
      where cf.register_shift_id = rs.id
        and pm.account_kind = 'cash'
        and coalesce(pm.affects_cashflow, false)
    ), 0)), 2) end,
    updated_at = now()
where rs.status = 'closed';

revoke all on function public.save_purchase_like_document_v65(jsonb, jsonb, jsonb) from public;
revoke all on function public.replace_purchase_like_document_v65(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_purchase_like_document_v65(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_purchase_like_document_v65(uuid, jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
