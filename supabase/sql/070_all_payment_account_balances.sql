-- v70: Show every payment type in the Cashflow account summary.
-- Run once after 069_enforce_payment_cashflow_setting.sql.

begin;

create or replace function public.get_payment_account_balances_v70()
returns table(
  payment_method_id uuid,
  payment_method_name text,
  account_kind text,
  is_paid_method boolean,
  affects_cashflow boolean,
  is_active boolean,
  balance numeric,
  non_cash_activity numeric,
  usage_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('manage_cashflow') then raise exception 'Cashflow permission required'; end if;

  return query
  select
    pm.id,
    pm.name,
    coalesce(pm.account_kind, 'other'),
    coalesce(pm.is_paid_method, true),
    coalesce(pm.affects_cashflow, false),
    pm.is_active,
    round(coalesce(sum(case
      when cf.entry_type = 'cash_in' then cf.amount
      when cf.entry_type = 'cash_out' then -cf.amount
      else 0
    end), 0), 2)::numeric as balance,
    round(coalesce(sum(case when cf.entry_type = 'non_cash' then cf.amount else 0 end), 0), 2)::numeric as non_cash_activity,
    greatest(
      count(cf.id),
      (select count(*) from public.documents d where d.payment_method_id = pm.id)
    )::bigint as usage_count
  from public.payment_methods pm
  left join public.cashflow_entries cf on cf.payment_method_id = pm.id
  group by pm.id, pm.name, pm.account_kind, pm.is_paid_method, pm.affects_cashflow, pm.is_active
  order by
    pm.is_active desc,
    case
      when coalesce(pm.is_paid_method, true) = false then 3
      when pm.account_kind = 'cash' then 1
      when pm.account_kind = 'bank' then 2
      else 4
    end,
    9 desc,
    pm.name;
end;
$$;

revoke all on function public.get_payment_account_balances_v70() from public;
grant execute on function public.get_payment_account_balances_v70() to authenticated;

notify pgrst, 'reload schema';
commit;
