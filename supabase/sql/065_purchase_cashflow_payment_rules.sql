-- v65: Respect each payment type's Affects Cashflow setting for purchases.
-- Run once after 064_quantity_only_stock_adjustments.sql.

begin;

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

  -- A paid method can settle the purchase without being part of shop cashflow.
  -- Remove only entries whose current payment-method configuration opts out.
  delete from public.cashflow_entries cf
  using public.payment_methods pm
  where cf.document_id = saved_document_id
    and cf.payment_method_id = pm.id
    and coalesce(pm.affects_cashflow, false) = false;

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

  delete from public.cashflow_entries cf
  using public.payment_methods pm
  where cf.document_id = p_document_id
    and cf.payment_method_id = pm.id
    and coalesce(pm.affects_cashflow, false) = false;

  delete from public.cheque_payments where document_id = p_document_id;
  perform public.record_cheque_payments_v56(p_document_id, p_payments, 'out');
end;
$$;

revoke all on function public.save_purchase_like_document_v65(jsonb, jsonb, jsonb) from public;
revoke all on function public.replace_purchase_like_document_v65(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_purchase_like_document_v65(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_purchase_like_document_v65(uuid, jsonb, jsonb, jsonb) to authenticated;

-- Correct purchase cashflow rows already created through a payment type that is
-- currently configured not to affect cashflow. Document/payment totals remain.
delete from public.cashflow_entries cf
using public.documents d, public.payment_methods pm
where cf.document_id = d.id
  and cf.payment_method_id = pm.id
  and d.document_type in ('purchase', 'stock_in_transit')
  and coalesce(pm.affects_cashflow, false) = false;

-- Keep previously closed register totals consistent if an incorrect historical
-- cash entry was removed above.
update public.register_shifts rs
set expected_cash = round(rs.opening_cash + coalesce((
      select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
      from public.cashflow_entries cf
      join public.payment_methods pm on pm.id = cf.payment_method_id
      where cf.register_shift_id = rs.id and pm.account_kind = 'cash'
    ), 0), 2),
    variance = case when rs.counted_cash is null then null else round(rs.counted_cash - (rs.opening_cash + coalesce((
      select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
      from public.cashflow_entries cf
      join public.payment_methods pm on pm.id = cf.payment_method_id
      where cf.register_shift_id = rs.id and pm.account_kind = 'cash'
    ), 0)), 2) end,
    updated_at = now()
where rs.status = 'closed';

notify pgrst, 'reload schema';
commit;
