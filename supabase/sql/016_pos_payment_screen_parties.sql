-- v16: cleaner POS payment screen + merged customer/supplier style profiles.
-- Run once after 015_pos_payment_popup_customer_balance.sql.

alter table public.customers
  add column if not exists is_customer boolean not null default true,
  add column if not exists is_supplier boolean not null default false;

-- Bring existing supplier names into the customer/profile list without deleting the suppliers table.
-- This lets one screen show customer/supplier/both profiles while purchase documents can still use suppliers for now.
insert into public.customers (name, phone, address, is_customer, is_supplier)
select s.name, s.phone, s.address, false, true
from public.suppliers s
where not exists (
  select 1
  from public.customers c
  where lower(trim(c.name)) = lower(trim(s.name))
    and coalesce(c.phone, '') = coalesce(s.phone, '')
);

update public.customers c
set is_supplier = true
from public.suppliers s
where lower(trim(c.name)) = lower(trim(s.name))
  and coalesce(c.phone, '') = coalesce(s.phone, '');

insert into public.payment_methods (name, affects_cashflow, is_paid_method, is_active)
values
  ('Cash', true, true, true),
  ('Bank', true, true, true),
  ('Credit', false, false, true)
on conflict (name) do update
set is_active = true,
    affects_cashflow = excluded.affects_cashflow,
    is_paid_method = excluded.is_paid_method;

create or replace function public.save_customer_balance_payment(
  p_customer_id uuid,
  p_payment_method_id uuid,
  p_amount numeric,
  p_direction text default 'in',
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  doc_no text;
  pm record;
  delta numeric(12,2);
  new_balance numeric(12,2);
begin
  if p_customer_id is null then
    raise exception 'Customer/supplier profile is required';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  select * into pm from public.payment_methods where id = p_payment_method_id;
  if not found then
    raise exception 'Payment method not found';
  end if;
  if coalesce(pm.is_paid_method, true) = false then
    raise exception 'Use a paid method such as Cash or Bank for balance payments/refunds';
  end if;

  doc_no := public.next_document_no('customer_payment');
  delta := case when coalesce(p_direction, 'in') = 'out' then p_amount else -1 * p_amount end;
  new_balance := public.apply_customer_outstanding_delta(p_customer_id, delta);

  insert into public.documents (
    document_no,
    document_type,
    status,
    customer_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    payment_method_id,
    document_date,
    notes
  ) values (
    doc_no,
    'customer_payment',
    'completed',
    p_customer_id,
    0,
    p_amount,
    0,
    'LKR',
    pm.id,
    now(),
    coalesce(p_note, case when coalesce(p_direction, 'in') = 'out' then 'Balance refund / payment out' else 'Balance payment received' end)
  ) returning id into doc_id;

  insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
  values (
    doc_id,
    case when coalesce(p_direction, 'in') = 'out' then 'cash_out' else 'cash_in' end,
    pm.name,
    pm.id,
    p_amount,
    case when coalesce(p_direction, 'in') = 'out' then 'Customer balance refund ' || doc_no else 'Customer balance payment ' || doc_no end
  );

  return jsonb_build_object('document_id', doc_id, 'document_no', doc_no, 'new_outstanding', new_balance);
end;
$$;

grant execute on function public.save_customer_balance_payment(uuid, uuid, numeric, text, text) to authenticated;
