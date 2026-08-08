-- v43: Cash/bank account classification and internal money transfers.
-- COD label and bill formatting is handled in the web app and needs no database changes.
-- Run after 042_double_entry_accounting_statements.sql.

begin;

alter table public.payment_methods
  add column if not exists account_kind text not null default 'other';

alter table public.payment_methods drop constraint if exists payment_methods_account_kind_check;
alter table public.payment_methods
  add constraint payment_methods_account_kind_check check (account_kind in ('cash', 'bank', 'other'));

update public.payment_methods
set account_kind = case
  when lower(trim(name)) = 'cash' then 'cash'
  when lower(name) like '%bank%' then 'bank'
  else account_kind
end;

update public.payment_methods generic_bank
set name = 'Bank 1', account_kind = 'bank'
where lower(trim(generic_bank.name)) = 'bank'
  and not exists (
    select 1 from public.payment_methods named_bank where lower(trim(named_bank.name)) = 'bank 1'
  );

insert into public.payment_methods(name, affects_cashflow, is_paid_method, is_active, account_kind)
select seed.name, true, true, true, 'bank'
from (values ('Bank 1'), ('Bank 2')) as seed(name)
where not exists (
  select 1 from public.payment_methods existing where lower(existing.name) = lower(seed.name)
);

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents
  add constraint documents_document_type_check check (document_type in (
    'invoice', 'quotation', 'purchase', 'stock_in_transit', 'stock_receiving',
    'refund', 'trade_in', 'job', 'customer_payment', 'supplier_payment',
    'expense', 'other_income', 'account_transfer', 'stock_adjustment',
    'online_order', 'cod_order'
  ));

create or replace function public.next_document_no(p_document_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  account_code text;
  doc_year integer;
  short_year text;
  next_no integer;
begin
  account_code := case p_document_type
    when 'invoice' then '100'
    when 'sale' then '100'
    when 'cod_order' then '120'
    when 'online_order' then '110'
    when 'purchase' then '200'
    when 'stock_in_transit' then '300'
    when 'quotation' then '400'
    when 'refund' then '500'
    when 'stock_adjustment' then '600'
    when 'trade_in' then '700'
    when 'job' then '750'
    when 'customer_payment' then '800'
    when 'supplier_payment' then '850'
    when 'expense' then '900'
    when 'other_income' then '950'
    when 'account_transfer' then '980'
    else '999'
  end;

  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');

  insert into public.document_sequences(document_type, document_year, last_no)
  values(p_document_type, doc_year, 1)
  on conflict(document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return short_year || account_code || lpad(next_no::text, 5, '0');
end;
$$;

create or replace function public.audit_document_operator_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare operator_id uuid;
declare needed_permission text;
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  operator_id := public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;

  if tg_op = 'DELETE' then
    if not public.has_pos_permission_v38('delete_documents') then raise exception 'You do not have permission to delete documents'; end if;
    return old;
  end if;

  needed_permission := case new.document_type
    when 'invoice' then 'pos_sales'
    when 'quotation' then 'create_quotes'
    when 'cod_order' then 'manage_cod_orders'
    when 'online_order' then 'manage_online_orders'
    when 'job' then 'manage_jobs'
    when 'purchase' then 'manage_inventory_documents'
    when 'stock_in_transit' then 'manage_inventory_documents'
    when 'stock_receiving' then 'manage_inventory_documents'
    when 'stock_adjustment' then 'manage_inventory_documents'
    when 'trade_in' then 'manage_inventory_documents'
    when 'customer_payment' then 'manage_parties'
    when 'supplier_payment' then 'manage_parties'
    when 'expense' then 'manage_cashflow'
    when 'other_income' then 'manage_cashflow'
    when 'account_transfer' then 'manage_cashflow'
    when 'refund' then 'process_returns'
    else 'view_documents'
  end;
  if not public.has_pos_permission_v38(needed_permission) then raise exception 'The active user does not have permission for this document action'; end if;

  if tg_op = 'INSERT' then new.created_by_staff_id := coalesce(new.created_by_staff_id, operator_id); end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

create or replace function public.get_cash_account_balances_v43()
returns table(
  payment_method_id uuid,
  payment_method_name text,
  account_kind text,
  is_active boolean,
  balance numeric
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
    pm.account_kind,
    pm.is_active,
    round(coalesce(sum(case
      when cf.entry_type = 'cash_in' then cf.amount
      when cf.entry_type = 'cash_out' then -cf.amount
      else 0
    end), 0), 2)::numeric as balance
  from public.payment_methods pm
  left join public.cashflow_entries cf on cf.payment_method_id = pm.id
  where coalesce(pm.is_paid_method, true) and pm.affects_cashflow
  group by pm.id, pm.name, pm.account_kind, pm.is_active
  order by pm.is_active desc, case pm.account_kind when 'cash' then 1 when 'bank' then 2 else 3 end, pm.name;
end;
$$;

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
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('manage_cashflow') then raise exception 'Cashflow permission required'; end if;
  if p_from_payment_method_id is null or p_to_payment_method_id is null then raise exception 'Select both transfer accounts'; end if;
  if p_from_payment_method_id = p_to_payment_method_id then raise exception 'Source and destination accounts must be different'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Transfer amount must be greater than zero'; end if;

  select * into source_method from public.payment_methods
  where id = p_from_payment_method_id and is_active and coalesce(is_paid_method, true) and affects_cashflow
    and account_kind in ('cash', 'bank');
  if not found then raise exception 'Source cash or bank account is unavailable'; end if;

  select * into destination_method from public.payment_methods
  where id = p_to_payment_method_id and is_active and coalesce(is_paid_method, true) and affects_cashflow
    and account_kind in ('cash', 'bank');
  if not found then raise exception 'Destination cash or bank account is unavailable'; end if;

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

  insert into public.cashflow_entries(
    document_id, entry_type, account_name, payment_method_id, amount, description
  ) values
    (document_id, 'cash_out', source_method.name, source_method.id, round(p_amount, 2), clean_description),
    (document_id, 'cash_in', destination_method.name, destination_method.id, round(p_amount, 2), clean_description);

  return jsonb_build_object(
    'document_id', document_id,
    'document_no', document_no,
    'from_account', source_method.name,
    'to_account', destination_method.name,
    'amount', round(p_amount, 2)
  );
end;
$$;

grant execute on function public.next_document_no(text) to authenticated;
grant execute on function public.get_cash_account_balances_v43() to authenticated;
grant execute on function public.save_cash_account_transfer_v43(uuid, uuid, numeric, text, date) to authenticated;

commit;
