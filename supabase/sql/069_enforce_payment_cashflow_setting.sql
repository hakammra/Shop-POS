-- v69: Enforce the payment method's Affects Cashflow setting at the cashflow table.
-- Run once after 068_sales_invoice_deletion.sql.

begin;

create or replace function public.enforce_payment_method_cashflow_v69()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  method_affects_cashflow boolean;
begin
  -- Credit/non-cash rows are accounting records rather than register movements.
  -- Only prevent actual Cash In / Cash Out rows for opted-out payment methods.
  if new.entry_type not in ('cash_in', 'cash_out') or new.payment_method_id is null then
    return new;
  end if;

  select pm.affects_cashflow
  into method_affects_cashflow
  from public.payment_methods pm
  where pm.id = new.payment_method_id;

  if found and coalesce(method_affects_cashflow, false) = false then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_payment_method_cashflow_v69_trigger on public.cashflow_entries;
create trigger enforce_payment_method_cashflow_v69_trigger
before insert on public.cashflow_entries
for each row execute function public.enforce_payment_method_cashflow_v69();

-- Remove incorrect historical register movements made through methods that are
-- currently configured not to affect cashflow. Documents, paid totals, stock,
-- costs and party balances are intentionally left unchanged.
delete from public.cashflow_entries cf
using public.payment_methods pm
where cf.payment_method_id = pm.id
  and cf.entry_type in ('cash_in', 'cash_out')
  and coalesce(pm.affects_cashflow, false) = false;

-- Keep closed daily-register totals correct after removing historical rows.
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
