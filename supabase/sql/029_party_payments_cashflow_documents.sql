-- v29: Every party payment and manual cash movement receives a document.
-- Run after 028_assembly_discounts_and_pos_line_allocation.sql.

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents
  add constraint documents_document_type_check check (document_type in (
    'invoice', 'quotation', 'purchase', 'stock_in_transit', 'stock_receiving',
    'refund', 'trade_in', 'job', 'customer_payment', 'supplier_payment',
    'expense', 'other_income', 'stock_adjustment', 'online_order', 'cod_order'
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
    else '999'
  end;

  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');

  insert into public.document_sequences (document_type, document_year, last_no)
  values (p_document_type, doc_year, 1)
  on conflict (document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return short_year || account_code || lpad(next_no::text, 5, '0');
end;
$$;

grant execute on function public.next_document_no(text) to authenticated;

create or replace function public.save_party_payment_v29(
  p_profile_id uuid,
  p_document_type text,
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
  profile_row record;
  supplier_target_id uuid;
  doc_id uuid;
  doc_no text;
  pm record;
  delta numeric(12,2);
  new_balance numeric(12,2);
  clean_type text := coalesce(nullif(p_document_type, ''), 'customer_payment');
  clean_direction text := coalesce(nullif(p_direction, ''), 'in');
begin
  if p_profile_id is null then raise exception 'Customer/supplier profile is required'; end if;
  if clean_type not in ('customer_payment', 'supplier_payment') then raise exception 'Unsupported payment document type'; end if;
  if clean_direction not in ('in', 'out') then raise exception 'Payment direction must be in or out'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;

  select * into profile_row from public.customers where id = p_profile_id for update;
  if not found then raise exception 'Customer/supplier profile not found'; end if;
  if clean_type = 'customer_payment' and coalesce(profile_row.is_customer, true) = false then
    raise exception 'This profile is not marked as a customer';
  end if;
  if clean_type = 'supplier_payment' and coalesce(profile_row.is_supplier, false) = false then
    raise exception 'This profile is not marked as a supplier';
  end if;

  select * into pm from public.payment_methods where id = p_payment_method_id;
  if not found then raise exception 'Payment method not found'; end if;
  if coalesce(pm.is_paid_method, true) = false then
    raise exception 'Use a paid method such as Cash or Bank for payments/refunds';
  end if;

  if clean_type = 'supplier_payment' then
    select s.id into supplier_target_id
    from public.suppliers s
    where lower(trim(s.name)) = lower(trim(profile_row.name))
      and (coalesce(profile_row.phone, '') = '' or coalesce(s.phone, '') = '' or s.phone = profile_row.phone)
    order by s.created_at
    limit 1;

    if supplier_target_id is null then
      insert into public.suppliers (name, phone, address)
      values (profile_row.name, profile_row.phone, profile_row.address)
      returning id into supplier_target_id;
    end if;
  end if;

  doc_no := public.next_document_no(clean_type);
  delta := case when clean_direction = 'out' then p_amount else -1 * p_amount end;
  new_balance := public.apply_customer_outstanding_delta(p_profile_id, delta);

  insert into public.documents (
    document_no, document_type, status, customer_id, supplier_id,
    total_amount, paid_amount, balance_amount, currency,
    payment_method_id, document_date, notes
  ) values (
    doc_no, clean_type, 'completed', p_profile_id, supplier_target_id,
    p_amount, p_amount, 0, 'LKR', pm.id, now(),
    coalesce(nullif(trim(p_note), ''), case
      when clean_type = 'supplier_payment' and clean_direction = 'out' then 'Supplier payment'
      when clean_type = 'supplier_payment' then 'Supplier refund received'
      when clean_direction = 'out' then 'Customer refund / payment'
      else 'Customer payment received'
    end)
  ) returning id into doc_id;

  insert into public.cashflow_entries (
    document_id, entry_type, account_name, payment_method_id, amount, description
  ) values (
    doc_id,
    case when clean_direction = 'out' then 'cash_out' else 'cash_in' end,
    pm.name,
    pm.id,
    p_amount,
    case when clean_type = 'supplier_payment' then 'Supplier payment document ' else 'Customer payment document ' end || doc_no
  );

  return jsonb_build_object(
    'document_id', doc_id,
    'document_no', doc_no,
    'document_type', clean_type,
    'new_outstanding', new_balance
  );
end;
$$;

grant execute on function public.save_party_payment_v29(uuid, text, uuid, numeric, text, text) to authenticated;

create or replace function public.save_manual_cashflow_document_v29(
  p_entry_type text,
  p_payment_method_id uuid,
  p_amount numeric,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pm record;
  doc_type text;
  doc_no text;
  doc_id uuid;
  clean_description text;
begin
  if p_entry_type not in ('cash_in', 'cash_out') then raise exception 'Manual movement must be cash in or cash out'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  select * into pm from public.payment_methods where id = p_payment_method_id;
  if not found then raise exception 'Payment method not found'; end if;
  if coalesce(pm.affects_cashflow, true) = false then raise exception 'Selected method does not affect cashflow'; end if;

  doc_type := case when p_entry_type = 'cash_out' then 'expense' else 'other_income' end;
  doc_no := public.next_document_no(doc_type);
  clean_description := coalesce(nullif(trim(p_description), ''), case when p_entry_type = 'cash_out' then 'Manual expense / cash out' else 'Manual cash in / other income' end);

  insert into public.documents (
    document_no, document_type, status, total_amount, paid_amount,
    balance_amount, currency, payment_method_id, document_date, notes
  ) values (
    doc_no, doc_type, 'completed', p_amount, p_amount,
    0, 'LKR', pm.id, now(), clean_description
  ) returning id into doc_id;

  insert into public.cashflow_entries (
    document_id, entry_type, account_name, payment_method_id, amount, description
  ) values (
    doc_id, p_entry_type, pm.name, pm.id, p_amount, clean_description
  );

  return jsonb_build_object('document_id', doc_id, 'document_no', doc_no, 'document_type', doc_type);
end;
$$;

grant execute on function public.save_manual_cashflow_document_v29(text, uuid, numeric, text) to authenticated;

-- Older payment documents used zero as total even though paid_amount held the receipt value.
update public.documents
set total_amount = paid_amount
where document_type in ('customer_payment', 'supplier_payment')
  and total_amount = 0
  and paid_amount <> 0;

-- Give historical orphaned cashflow rows a source document too.
do $$
declare
  flow record;
  backfill_doc_id uuid;
  backfill_doc_no text;
  backfill_type text;
begin
  for flow in
    select * from public.cashflow_entries where document_id is null order by created_at, id
  loop
    backfill_type := case when flow.entry_type = 'cash_in' then 'other_income' else 'expense' end;
    backfill_doc_no := public.next_document_no(backfill_type);
    insert into public.documents (
      document_no, document_type, status, total_amount, paid_amount,
      balance_amount, currency, payment_method_id, document_date, notes
    ) values (
      backfill_doc_no, backfill_type, 'completed', flow.amount, flow.amount,
      0, 'LKR', flow.payment_method_id, flow.created_at, coalesce(flow.description, 'Historical cashflow movement')
    ) returning id into backfill_doc_id;
    update public.cashflow_entries set document_id = backfill_doc_id where id = flow.id;
  end loop;
end;
$$;

-- Enforce the accounting rule for future rows as well.
alter table public.cashflow_entries
  drop constraint if exists cashflow_entries_document_id_fkey;
alter table public.cashflow_entries
  alter column document_id set not null;
alter table public.cashflow_entries
  add constraint cashflow_entries_document_id_fkey
  foreign key (document_id) references public.documents(id) on delete cascade;

notify pgrst, 'reload schema';
