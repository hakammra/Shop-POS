-- v42: Admin-only double-entry accounting, automatic statements, expense categories,
-- opening balances and partner/investor profit allocation.
-- Run once after 041_admin_app_settings.sql.

begin;

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'income', 'cogs', 'expense')),
  statement_section text not null check (statement_section in (
    'fixed_asset', 'current_asset', 'non_current_asset', 'current_liability',
    'long_term_liability', 'equity', 'sales', 'other_income', 'cogs', 'expense'
  )),
  normal_side text not null check (normal_side in ('debit', 'credit')),
  system_key text unique,
  is_system boolean not null default false,
  is_active boolean not null default true,
  display_order integer not null default 100,
  profit_group text check (profit_group in ('partner', 'investor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounting_journal_entries (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_key text not null,
  source_document_id uuid references public.documents(id) on delete cascade,
  entry_date date not null,
  reference_no text,
  description text not null,
  is_manual boolean not null default false,
  created_by_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_key)
);

create table if not exists public.accounting_journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.accounting_journal_entries(id) on delete cascade,
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  memo text,
  created_at timestamptz not null default now(),
  check ((debit = 0 and credit > 0) or (credit = 0 and debit > 0))
);

create table if not exists public.accounting_opening_balances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.accounting_accounts(id) on delete cascade,
  opening_date date not null,
  balance numeric(14,2) not null default 0,
  notes text,
  updated_at timestamptz not null default now()
);

create table if not exists public.accounting_settings (
  id boolean primary key default true check (id = true),
  operator_percent numeric(7,4) not null default 20 check (operator_percent between 0 and 100),
  reserve_percent numeric(7,4) not null default 5 check (reserve_percent between 0 and 100),
  partner_pool_percent numeric(7,4) not null default 60 check (partner_pool_percent between 0 and 100),
  updated_at timestamptz not null default now()
);

alter table public.documents
  add column if not exists accounting_account_id uuid references public.accounting_accounts(id) on delete set null;

create index if not exists accounting_journal_entry_date_idx on public.accounting_journal_entries(entry_date, id);
create index if not exists accounting_journal_source_document_idx on public.accounting_journal_entries(source_document_id);
create index if not exists accounting_journal_lines_account_idx on public.accounting_journal_lines(account_id, journal_entry_id);

insert into public.accounting_settings(id) values(true) on conflict(id) do nothing;

insert into public.accounting_accounts(code, name, account_type, statement_section, normal_side, system_key, is_system, display_order) values
  ('1000', 'Cash', 'asset', 'current_asset', 'debit', 'cash', true, 100),
  ('1100', 'Accounts Receivable', 'asset', 'current_asset', 'debit', 'accounts_receivable', true, 200),
  ('1200', 'Inventory', 'asset', 'current_asset', 'debit', 'inventory', true, 300),
  ('1210', 'Stock in Transit', 'asset', 'current_asset', 'debit', 'stock_in_transit', true, 310),
  ('1220', 'Return and Damaged Stock', 'asset', 'current_asset', 'debit', 'damaged_inventory', true, 320),
  ('1230', 'Trade-in Stock Pending', 'asset', 'current_asset', 'debit', 'trade_in_inventory', true, 330),
  ('1500', 'Equipment', 'asset', 'fixed_asset', 'debit', 'equipment', true, 500),
  ('1600', 'Security Deposits', 'asset', 'non_current_asset', 'debit', 'security_deposit', true, 600),
  ('2000', 'Accounts Payable', 'liability', 'current_liability', 'credit', 'accounts_payable', true, 700),
  ('2050', 'Customer Credit Balances', 'liability', 'current_liability', 'credit', 'customer_credits', true, 710),
  ('3000', 'Owner Equity', 'equity', 'equity', 'credit', 'owner_equity', true, 800),
  ('3090', 'Opening Balance Equity', 'equity', 'equity', 'credit', 'opening_balance_equity', true, 890),
  ('3095', 'Inventory Opening and Revaluation', 'equity', 'equity', 'credit', 'inventory_revaluation_equity', true, 895),
  ('3096', 'Party Opening Balance Equity', 'equity', 'equity', 'credit', 'party_opening_equity', true, 896),
  ('3099', 'Accounting Difference', 'equity', 'equity', 'credit', 'accounting_difference', true, 899),
  ('4000', 'Sales', 'income', 'sales', 'credit', 'sales', true, 1000),
  ('4010', 'Sales Returns', 'income', 'sales', 'debit', 'sales_returns', true, 1010),
  ('4100', 'Other Income', 'income', 'other_income', 'credit', 'other_income', true, 1100),
  ('4200', 'Inventory Adjustment Income', 'income', 'other_income', 'credit', 'inventory_gain', true, 1110),
  ('5000', 'Cost of Goods Sold', 'cogs', 'cogs', 'debit', 'cogs', true, 1200),
  ('6000', 'Depreciation', 'expense', 'expense', 'debit', 'expense_depreciation', true, 2000),
  ('6010', 'Travelling', 'expense', 'expense', 'debit', 'expense_travelling', true, 2010),
  ('6020', 'Miscellaneous', 'expense', 'expense', 'debit', 'expense_miscellaneous', true, 2020),
  ('6030', 'Salary', 'expense', 'expense', 'debit', 'expense_salary', true, 2030),
  ('6040', 'Commission', 'expense', 'expense', 'debit', 'expense_commission', true, 2040),
  ('6050', 'Rent', 'expense', 'expense', 'debit', 'expense_rent', true, 2050),
  ('6060', 'Bank Charges', 'expense', 'expense', 'debit', 'expense_bank_charges', true, 2060),
  ('6070', 'Courier and Delivery', 'expense', 'expense', 'debit', 'expense_courier', true, 2070),
  ('6080', 'Utilities', 'expense', 'expense', 'debit', 'expense_utilities', true, 2080),
  ('6090', 'Advertising', 'expense', 'expense', 'debit', 'expense_advertising', true, 2090),
  ('6100', 'Repairs and Maintenance', 'expense', 'expense', 'debit', 'expense_maintenance', true, 2100),
  ('6110', 'Inventory Loss and Damage', 'expense', 'expense', 'debit', 'inventory_loss', true, 2110)
on conflict(system_key) do update set
  name = excluded.name,
  account_type = excluded.account_type,
  statement_section = excluded.statement_section,
  normal_side = excluded.normal_side,
  is_system = true,
  display_order = excluded.display_order,
  updated_at = now();

alter table public.accounting_accounts enable row level security;
alter table public.accounting_journal_entries enable row level security;
alter table public.accounting_journal_lines enable row level security;
alter table public.accounting_opening_balances enable row level security;
alter table public.accounting_settings enable row level security;

revoke all on public.accounting_accounts, public.accounting_journal_entries,
  public.accounting_journal_lines, public.accounting_opening_balances,
  public.accounting_settings from anon, authenticated;

create or replace function public.assert_accounting_admin_v42()
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  staff_id uuid;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  staff_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff s where s.id = staff_id and s.role = 'admin' and s.is_active) then
    raise exception 'Accounting is restricted to an active administrator';
  end if;
  return staff_id;
end;
$$;

create or replace function public.accounting_account_id_v42(p_system_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare result_id uuid;
begin
  select id into result_id from public.accounting_accounts where system_key = p_system_key;
  if result_id is null then raise exception 'Accounting account is missing: %', p_system_key; end if;
  return result_id;
end;
$$;

create or replace function public.ensure_payment_account_v42(p_payment_method_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  method_row public.payment_methods%rowtype;
  account_id uuid;
  clean_name text;
begin
  select * into method_row from public.payment_methods where id = p_payment_method_id;
  if not found then raise exception 'Payment method not found while posting accounting entry'; end if;
  if coalesce(method_row.is_paid_method, true) = false then return null; end if;

  clean_name := case
    when lower(method_row.name) = 'cash' then 'Cash'
    when lower(method_row.name) like '%bank%' then method_row.name
    when lower(method_row.name) like '%card%' then method_row.name || ' Receivable'
    when lower(method_row.name) like '%cheque%' or lower(method_row.name) like '%check%' then 'Cheques'
    else method_row.name
  end;

  if lower(method_row.name) = 'cash' then
    return public.accounting_account_id_v42('cash');
  end if;

  insert into public.accounting_accounts(
    code, name, account_type, statement_section, normal_side,
    system_key, is_system, display_order
  ) values (
    'PM-' || upper(substr(replace(method_row.id::text, '-', ''), 1, 8)),
    clean_name, 'asset', 'current_asset', 'debit',
    'payment:' || method_row.id::text, true, 150
  )
  on conflict(system_key) do update set name = excluded.name, is_active = true, updated_at = now()
  returning id into account_id;
  return account_id;
end;
$$;

create or replace function public.add_accounting_line_v42(
  p_entry_id uuid,
  p_account_id uuid,
  p_debit numeric,
  p_credit numeric,
  p_memo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  debit_value numeric(14,2) := round(greatest(coalesce(p_debit, 0), 0), 2);
  credit_value numeric(14,2) := round(greatest(coalesce(p_credit, 0), 0), 2);
begin
  if debit_value = 0 and credit_value = 0 then return; end if;
  if debit_value > 0 and credit_value > 0 then raise exception 'A journal line cannot contain both debit and credit'; end if;
  insert into public.accounting_journal_lines(journal_entry_id, account_id, debit, credit, memo)
  values(p_entry_id, p_account_id, debit_value, credit_value, nullif(trim(coalesce(p_memo, '')), ''));
end;
$$;

create or replace function public.sync_accounting_document_v42(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc public.documents%rowtype;
  entry_id uuid;
  flow record;
  item record;
  payment_account_id uuid;
  expense_account_id uuid;
  positive_sales numeric(14,2) := 0;
  returned_sales numeric(14,2) := 0;
  document_value numeric(14,2) := 0;
  flow_net numeric(14,2) := 0;
  outstanding_value numeric(14,2) := 0;
  cost_value numeric(14,2);
  total_debit numeric(14,2);
  total_credit numeric(14,2);
begin
  select * into doc from public.documents where id = p_document_id;
  if not found then
    delete from public.accounting_journal_entries where source_type = 'document' and source_key = p_document_id::text;
    return;
  end if;

  delete from public.accounting_journal_entries where source_type = 'document' and source_key = p_document_id::text;
  insert into public.accounting_journal_entries(
    source_type, source_key, source_document_id, entry_date, reference_no, description, is_manual
  ) values (
    'document', doc.id::text, doc.id, coalesce(doc.document_date::date, doc.created_at::date),
    doc.document_no, coalesce(nullif(doc.notes, ''), replace(initcap(doc.document_type), '_', ' ')), false
  ) returning id into entry_id;

  for flow in
    select cf.*, pm.is_paid_method
    from public.cashflow_entries cf
    left join public.payment_methods pm on pm.id = cf.payment_method_id
    where cf.document_id = doc.id and cf.entry_type in ('cash_in', 'cash_out')
    order by cf.created_at, cf.id
  loop
    payment_account_id := public.ensure_payment_account_v42(flow.payment_method_id);
    if flow.entry_type = 'cash_in' then
      perform public.add_accounting_line_v42(entry_id, payment_account_id, flow.amount, 0, flow.description);
      flow_net := flow_net + flow.amount;
    else
      perform public.add_accounting_line_v42(entry_id, payment_account_id, 0, flow.amount, flow.description);
      flow_net := flow_net - flow.amount;
    end if;
  end loop;

  if doc.document_type in ('invoice', 'refund') then
    select
      coalesce(sum(case when line_total > 0 then line_total else 0 end), 0),
      coalesce(sum(case when line_total < 0 then abs(line_total) else 0 end), 0)
    into positive_sales, returned_sales
    from public.document_items where document_id = doc.id;

    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('sales'), 0, positive_sales, 'Sales');
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('sales_returns'), returned_sales, 0, 'Sales returns');

    outstanding_value := round(coalesce(doc.total_amount, positive_sales - returned_sales) - flow_net, 2);
    if outstanding_value >= 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_receivable'), outstanding_value, 0, 'Customer outstanding');
    else
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), 0, abs(outstanding_value), 'Customer credit balance');
    end if;

    for item in
      select di.*, coalesce(p.track_inventory, true) as track_inventory
      from public.document_items di
      left join public.products p on p.id = di.product_id
      where di.document_id = doc.id and coalesce(p.track_inventory, true)
    loop
      cost_value := round(abs(coalesce(item.qty, 0)) * coalesce(item.unit_cost, 0), 2);
      if item.qty > 0 then
        perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('cogs'), cost_value, 0, item.description);
        perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), 0, cost_value, item.description);
      elsif item.qty < 0 then
        if coalesce(item.return_condition, 'sellable') = 'warranty_damaged' then
          perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('damaged_inventory'), cost_value, 0, item.description);
        else
          perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), cost_value, 0, item.description);
        end if;
        perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('cogs'), 0, cost_value, item.description);
      end if;
    end loop;

  elsif doc.document_type in ('purchase', 'stock_in_transit') then
    select coalesce(sum(coalesce(line_total, qty * unit_cost)), abs(doc.total_amount), 0)
    into document_value from public.document_items where document_id = doc.id;
    document_value := abs(document_value);

    if doc.document_type = 'purchase' and doc.linked_document_id is not null
       and exists(select 1 from public.documents source_doc where source_doc.id = doc.linked_document_id and source_doc.document_type = 'stock_in_transit') then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), document_value, 0, 'Received from stock in transit');
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('stock_in_transit'), 0, document_value, 'Received from stock in transit');
    else
      perform public.add_accounting_line_v42(
        entry_id,
        public.accounting_account_id_v42(case when doc.document_type = 'purchase' then 'inventory' else 'stock_in_transit' end),
        document_value, 0, replace(initcap(doc.document_type), '_', ' ')
      );
      outstanding_value := round(document_value + flow_net, 2);
      if outstanding_value >= 0 then
        perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), 0, outstanding_value, 'Supplier outstanding');
      else
        perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), abs(outstanding_value), 0, 'Supplier overpayment');
      end if;
    end if;

  elsif doc.document_type = 'customer_payment' then
    if flow_net >= 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_receivable'), 0, flow_net, 'Customer payment received');
    else
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), abs(flow_net), 0, 'Customer refund paid');
    end if;

  elsif doc.document_type = 'supplier_payment' then
    if flow_net <= 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), abs(flow_net), 0, 'Supplier payment');
    else
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), 0, flow_net, 'Supplier refund received');
    end if;

  elsif doc.document_type = 'expense' then
    expense_account_id := coalesce(doc.accounting_account_id, public.accounting_account_id_v42('expense_miscellaneous'));
    perform public.add_accounting_line_v42(entry_id, expense_account_id, abs(coalesce(doc.total_amount, flow_net)), 0, doc.notes);

  elsif doc.document_type = 'other_income' then
    expense_account_id := coalesce(doc.accounting_account_id, public.accounting_account_id_v42('other_income'));
    perform public.add_accounting_line_v42(entry_id, expense_account_id, 0, abs(coalesce(doc.total_amount, flow_net)), doc.notes);

  elsif doc.document_type = 'trade_in' then
    document_value := abs(coalesce(doc.total_amount, 0));
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('trade_in_inventory'), document_value, 0, 'Trade-in received');
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), 0, document_value, 'Amount owed for trade-in');

  elsif doc.document_type = 'stock_adjustment' then
    document_value := coalesce(doc.total_amount, 0);
    if document_value >= 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), document_value, 0, 'Stock adjustment increase');
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory_gain'), 0, document_value, 'Stock adjustment increase');
    else
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory_loss'), abs(document_value), 0, 'Stock adjustment decrease');
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), 0, abs(document_value), 'Stock adjustment decrease');
    end if;

  elsif doc.document_type = 'cod_order' and flow_net < 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('expense_courier'), abs(flow_net), 0, 'COD delivery charge');
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
  into total_debit, total_credit
  from public.accounting_journal_lines where journal_entry_id = entry_id;

  if total_debit > total_credit then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounting_difference'), 0, total_debit - total_credit, 'Automatic balancing difference');
  elsif total_credit > total_debit then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounting_difference'), total_credit - total_debit, 0, 'Automatic balancing difference');
  end if;

  if not exists(select 1 from public.accounting_journal_lines where journal_entry_id = entry_id) then
    delete from public.accounting_journal_entries where id = entry_id;
  end if;
end;
$$;

create or replace function public.accounting_document_trigger_v42()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.accounting_journal_entries where source_type = 'document' and source_key = old.id::text;
    return old;
  end if;
  perform public.sync_accounting_document_v42(new.id);
  return new;
end;
$$;

create or replace function public.accounting_document_child_trigger_v42()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_accounting_document_v42(case when tg_op = 'DELETE' then old.document_id else new.document_id end);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists accounting_documents_sync_v42 on public.documents;
create trigger accounting_documents_sync_v42
after insert or update or delete on public.documents
for each row execute function public.accounting_document_trigger_v42();

drop trigger if exists accounting_document_items_sync_v42 on public.document_items;
create trigger accounting_document_items_sync_v42
after insert or update or delete on public.document_items
for each row execute function public.accounting_document_child_trigger_v42();

drop trigger if exists accounting_cashflow_sync_v42 on public.cashflow_entries;
create trigger accounting_cashflow_sync_v42
after insert or update or delete on public.cashflow_entries
for each row execute function public.accounting_document_child_trigger_v42();

create or replace function public.rebuild_opening_balance_v42(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  opening_row public.accounting_opening_balances%rowtype;
  account_row public.accounting_accounts%rowtype;
  entry_id uuid;
  amount_value numeric(14,2);
begin
  delete from public.accounting_journal_entries where source_type = 'opening' and source_key = p_account_id::text;
  select * into opening_row from public.accounting_opening_balances where account_id = p_account_id;
  if not found or abs(opening_row.balance) < 0.005 then return; end if;
  select * into account_row from public.accounting_accounts where id = p_account_id;
  if not found or account_row.system_key in ('opening_balance_equity', 'inventory_revaluation_equity', 'party_opening_equity', 'accounting_difference') then return; end if;

  amount_value := abs(opening_row.balance);
  insert into public.accounting_journal_entries(source_type, source_key, entry_date, reference_no, description, is_manual)
  values('opening', p_account_id::text, opening_row.opening_date, 'OPEN-' || account_row.code, 'Opening balance - ' || account_row.name, true)
  returning id into entry_id;

  if (account_row.normal_side = 'debit' and opening_row.balance >= 0) or (account_row.normal_side = 'credit' and opening_row.balance < 0) then
    perform public.add_accounting_line_v42(entry_id, account_row.id, amount_value, 0, opening_row.notes);
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('opening_balance_equity'), 0, amount_value, opening_row.notes);
  else
    perform public.add_accounting_line_v42(entry_id, account_row.id, 0, amount_value, opening_row.notes);
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('opening_balance_equity'), amount_value, 0, opening_row.notes);
  end if;
end;
$$;

create or replace function public.reconcile_inventory_ledger_v42()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry_id uuid;
  inventory_actual numeric(14,2);
  transit_actual numeric(14,2);
  damaged_actual numeric(14,2);
  ledger_value numeric(14,2);
  difference_value numeric(14,2);
  offset_value numeric(14,2) := 0;
  target record;
begin
  select
    round(coalesce(sum(sb.sellable_qty * p.avg_cost), 0), 2),
    round(coalesce(sum(sb.in_transit_qty * p.avg_cost), 0), 2),
    round(coalesce(sum((sb.damaged_qty + sb.checking_qty) * p.avg_cost), 0), 2)
  into inventory_actual, transit_actual, damaged_actual
  from public.stock_balances sb
  join public.products p on p.id = sb.product_id and coalesce(p.track_inventory, true);

  delete from public.accounting_journal_entries where source_type = 'system' and source_key = 'inventory-reconciliation';
  insert into public.accounting_journal_entries(source_type, source_key, entry_date, reference_no, description)
  values('system', 'inventory-reconciliation', current_date, 'AUTO-STOCK', 'Automatic opening stock and inventory reconciliation')
  returning id into entry_id;

  for target in select * from (values
    ('inventory'::text, inventory_actual),
    ('stock_in_transit'::text, transit_actual),
    ('damaged_inventory'::text, damaged_actual)
  ) as x(system_key, actual_value)
  loop
    select round(coalesce(sum(jl.debit - jl.credit), 0), 2)
    into ledger_value
    from public.accounting_journal_lines jl
    join public.accounting_journal_entries je on je.id = jl.journal_entry_id
    where jl.account_id = public.accounting_account_id_v42(target.system_key)
      and not (je.source_type = 'system' and je.source_key = 'inventory-reconciliation');
    difference_value := round(target.actual_value - ledger_value, 2);
    if difference_value > 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42(target.system_key), difference_value, 0, 'Match current stock valuation');
    elsif difference_value < 0 then
      perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42(target.system_key), 0, abs(difference_value), 'Match current stock valuation');
    end if;
    offset_value := offset_value + difference_value;
  end loop;

  if offset_value > 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory_revaluation_equity'), 0, offset_value, 'Inventory opening/revaluation offset');
  elsif offset_value < 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory_revaluation_equity'), abs(offset_value), 0, 'Inventory opening/revaluation offset');
  end if;
  if not exists(select 1 from public.accounting_journal_lines where journal_entry_id = entry_id) then delete from public.accounting_journal_entries where id = entry_id; end if;
end;
$$;

create or replace function public.reconcile_party_ledger_v42()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  entry_id uuid;
  receivable_actual numeric(14,2);
  payable_actual numeric(14,2);
  receivable_ledger numeric(14,2);
  payable_ledger numeric(14,2);
  receivable_difference numeric(14,2);
  payable_difference numeric(14,2);
  offset_value numeric(14,2) := 0;
begin
  select
    round(coalesce(sum(greatest(coalesce(due_balance, 0) - coalesce(store_credit_balance, 0), 0)), 0), 2),
    round(coalesce(sum(greatest(coalesce(store_credit_balance, 0) - coalesce(due_balance, 0), 0)), 0), 2)
  into receivable_actual, payable_actual from public.customers;

  delete from public.accounting_journal_entries where source_type = 'system' and source_key = 'party-reconciliation';
  select round(coalesce(sum(jl.debit - jl.credit), 0), 2) into receivable_ledger
  from public.accounting_journal_lines jl join public.accounting_journal_entries je on je.id = jl.journal_entry_id
  where jl.account_id = public.accounting_account_id_v42('accounts_receivable')
    and not (je.source_type = 'system' and je.source_key = 'party-reconciliation');
  select round(coalesce(sum(jl.credit - jl.debit), 0), 2) into payable_ledger
  from public.accounting_journal_lines jl join public.accounting_journal_entries je on je.id = jl.journal_entry_id
  where jl.account_id in (public.accounting_account_id_v42('accounts_payable'), public.accounting_account_id_v42('customer_credits'))
    and not (je.source_type = 'system' and je.source_key = 'party-reconciliation');

  receivable_difference := receivable_actual - receivable_ledger;
  payable_difference := payable_actual - payable_ledger;
  insert into public.accounting_journal_entries(source_type, source_key, entry_date, reference_no, description)
  values('system', 'party-reconciliation', current_date, 'AUTO-PARTY', 'Automatic customer and supplier opening balance reconciliation')
  returning id into entry_id;

  if receivable_difference > 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_receivable'), receivable_difference, 0, 'Match customer receivables');
  elsif receivable_difference < 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_receivable'), 0, abs(receivable_difference), 'Match customer receivables');
  end if;
  offset_value := offset_value + receivable_difference;

  if payable_difference > 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), 0, payable_difference, 'Match customer/supplier credits');
  elsif payable_difference < 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('accounts_payable'), abs(payable_difference), 0, 'Match customer/supplier credits');
  end if;
  offset_value := offset_value - payable_difference;

  if offset_value > 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('party_opening_equity'), 0, offset_value, 'Party opening balance offset');
  elsif offset_value < 0 then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('party_opening_equity'), abs(offset_value), 0, 'Party opening balance offset');
  end if;
  if not exists(select 1 from public.accounting_journal_lines where journal_entry_id = entry_id) then delete from public.accounting_journal_entries where id = entry_id; end if;
end;
$$;

create or replace function public.accounting_stock_reconcile_trigger_v42()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.reconcile_inventory_ledger_v42();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

create or replace function public.accounting_party_reconcile_trigger_v42()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.reconcile_party_ledger_v42();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

drop trigger if exists accounting_stock_reconcile_v42 on public.stock_balances;
create constraint trigger accounting_stock_reconcile_v42
after insert or update or delete on public.stock_balances deferrable initially deferred
for each row execute function public.accounting_stock_reconcile_trigger_v42();

drop trigger if exists accounting_party_reconcile_v42 on public.customers;
create constraint trigger accounting_party_reconcile_v42
after insert or update or delete on public.customers deferrable initially deferred
for each row execute function public.accounting_party_reconcile_trigger_v42();

create or replace function public.get_accounting_report_v42(
  p_from date,
  p_to date,
  p_as_of date
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  from_date date := coalesce(p_from, date_trunc('month', current_date)::date);
  to_date date := coalesce(p_to, current_date);
  as_of_date date := coalesce(p_as_of, current_date);
  current_earnings numeric(14,2);
begin
  perform public.assert_accounting_admin_v42();
  if from_date > to_date then raise exception 'From date cannot be after to date'; end if;

  select round(coalesce(sum(case
    when a.account_type = 'income' then jl.credit - jl.debit
    when a.account_type in ('cogs', 'expense') then jl.credit - jl.debit
    else 0 end), 0), 2)
  into current_earnings
  from public.accounting_journal_lines jl
  join public.accounting_journal_entries je on je.id = jl.journal_entry_id
  join public.accounting_accounts a on a.id = jl.account_id
  where je.entry_date <= as_of_date and a.account_type in ('income', 'cogs', 'expense');

  return jsonb_build_object(
    'period', jsonb_build_object('from', from_date, 'to', to_date, 'as_of', as_of_date),
    'settings', (select to_jsonb(s) from public.accounting_settings s where s.id = true),
    'accounts', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.display_order, x.code) from (
        select a.id, a.code, a.name, a.account_type, a.statement_section, a.normal_side,
          a.system_key, a.is_system, a.is_active, a.display_order, a.profit_group,
          coalesce(ob.balance, 0) as opening_balance, ob.opening_date
        from public.accounting_accounts a
        left join public.accounting_opening_balances ob on ob.account_id = a.id
      ) x
    ), '[]'::jsonb),
    'income', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.display_order, x.code) from (
        select a.id, a.code, a.name, a.account_type, a.statement_section, a.normal_side,
          a.display_order,
          round(coalesce(sum(case
            when je.entry_date between from_date and to_date and a.account_type = 'income' then jl.credit - jl.debit
            when je.entry_date between from_date and to_date and a.account_type in ('cogs', 'expense') then jl.debit - jl.credit
            else 0 end), 0), 2) as balance
        from public.accounting_accounts a
        left join public.accounting_journal_lines jl on jl.account_id = a.id
        left join public.accounting_journal_entries je on je.id = jl.journal_entry_id
        where a.account_type in ('income', 'cogs', 'expense') and a.is_active
        group by a.id
      ) x
    ), '[]'::jsonb),
    'balance', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.display_order, x.code) from (
        select a.id, a.code, a.name, a.account_type, a.statement_section, a.normal_side,
          a.display_order, a.profit_group,
          round(coalesce(sum(case
            when je.entry_date <= as_of_date and a.account_type = 'asset' then jl.debit - jl.credit
            when je.entry_date <= as_of_date and a.account_type in ('liability', 'equity') then jl.credit - jl.debit
            else 0 end), 0), 2) as balance
        from public.accounting_accounts a
        left join public.accounting_journal_lines jl on jl.account_id = a.id
        left join public.accounting_journal_entries je on je.id = jl.journal_entry_id
        where a.account_type in ('asset', 'liability', 'equity') and a.is_active
        group by a.id
      ) x
    ), '[]'::jsonb),
    'current_earnings', current_earnings,
    'ledger', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.entry_date desc, x.entry_id desc, x.line_id) from (
        select je.id as entry_id, jl.id as line_id, je.entry_date, je.reference_no, je.description,
          je.source_type, je.source_document_id, a.code, a.name as account_name,
          jl.debit, jl.credit, jl.memo
        from public.accounting_journal_entries je
        join public.accounting_journal_lines jl on jl.journal_entry_id = je.id
        join public.accounting_accounts a on a.id = jl.account_id
        where je.entry_date between from_date and to_date
        order by je.entry_date desc, je.id desc, jl.id
        limit 10000
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_accounting_cash_document_v42(
  p_entry_type text,
  p_payment_method_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_description text,
  p_document_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  staff_id uuid;
  account_row public.accounting_accounts%rowtype;
  method_row public.payment_methods%rowtype;
  doc_id uuid;
  doc_no text;
  doc_type text;
begin
  staff_id := public.assert_accounting_admin_v42();
  if p_entry_type not in ('cash_out', 'cash_in') then raise exception 'Choose cash in or cash out'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  select * into account_row from public.accounting_accounts where id = p_account_id and is_active;
  if not found then raise exception 'Accounting category not found'; end if;
  if p_entry_type = 'cash_out' and account_row.account_type <> 'expense' then raise exception 'Cash out requires an expense account'; end if;
  if p_entry_type = 'cash_in' and account_row.account_type <> 'income' then raise exception 'Cash in requires an income account'; end if;
  select * into method_row from public.payment_methods where id = p_payment_method_id and is_active and coalesce(is_paid_method, true) and affects_cashflow;
  if not found then raise exception 'Select an active cash or bank payment method'; end if;

  doc_type := case when p_entry_type = 'cash_out' then 'expense' else 'other_income' end;
  doc_no := public.next_document_no(doc_type);
  insert into public.documents(
    document_no, document_type, status, total_amount, paid_amount, balance_amount,
    currency, payment_method_id, accounting_account_id, document_date, notes,
    created_by_staff_id, updated_by_staff_id
  ) values (
    doc_no, doc_type, 'completed', round(p_amount, 2), round(p_amount, 2), 0,
    'LKR', method_row.id, account_row.id, coalesce(p_document_date, current_date),
    nullif(trim(coalesce(p_description, '')), ''), staff_id, staff_id
  ) returning id into doc_id;

  insert into public.cashflow_entries(document_id, entry_type, account_name, payment_method_id, amount, description, created_at)
  values(doc_id, p_entry_type, method_row.name, method_row.id, round(p_amount, 2),
    coalesce(nullif(trim(coalesce(p_description, '')), ''), account_row.name),
    coalesce(p_document_date, current_date)::timestamptz);

  return jsonb_build_object('document_id', doc_id, 'document_no', doc_no, 'document_type', doc_type);
end;
$$;

create or replace function public.admin_save_account_v42(
  p_account_id uuid,
  p_code text,
  p_name text,
  p_account_type text,
  p_statement_section text,
  p_normal_side text,
  p_profit_group text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare target_id uuid := p_account_id;
begin
  perform public.assert_accounting_admin_v42();
  if trim(coalesce(p_name, '')) = '' then raise exception 'Account name is required'; end if;
  if p_account_type not in ('asset', 'liability', 'equity', 'income', 'cogs', 'expense') then raise exception 'Invalid account type'; end if;
  if p_statement_section not in ('fixed_asset', 'current_asset', 'non_current_asset', 'current_liability', 'long_term_liability', 'equity', 'sales', 'other_income', 'cogs', 'expense') then raise exception 'Invalid statement section'; end if;
  if p_normal_side not in ('debit', 'credit') then raise exception 'Invalid normal side'; end if;
  if p_profit_group is not null and (p_account_type <> 'equity' or p_profit_group not in ('partner', 'investor')) then raise exception 'Profit groups are only available for equity accounts'; end if;

  if target_id is null then
    insert into public.accounting_accounts(code, name, account_type, statement_section, normal_side, profit_group, display_order)
    values(
      coalesce(nullif(upper(trim(p_code)), ''), 'CUS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
      trim(p_name), p_account_type, p_statement_section, p_normal_side, p_profit_group,
      900 + (select count(*) from public.accounting_accounts where not is_system)
    ) returning id into target_id;
  else
    if exists(select 1 from public.accounting_accounts where id = target_id and is_system) then raise exception 'System accounts cannot be renamed or reclassified'; end if;
    update public.accounting_accounts set
      code = coalesce(nullif(upper(trim(p_code)), ''), code), name = trim(p_name),
      account_type = p_account_type, statement_section = p_statement_section,
      normal_side = p_normal_side, profit_group = p_profit_group, updated_at = now()
    where id = target_id;
    if not found then raise exception 'Account not found'; end if;
  end if;
  return target_id;
end;
$$;

create or replace function public.admin_save_opening_balance_v42(
  p_account_id uuid,
  p_balance numeric,
  p_opening_date date,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.assert_accounting_admin_v42();
  if not exists(select 1 from public.accounting_accounts where id = p_account_id) then raise exception 'Account not found'; end if;
  insert into public.accounting_opening_balances(account_id, opening_date, balance, notes, updated_at)
  values(p_account_id, coalesce(p_opening_date, current_date), round(coalesce(p_balance, 0), 2), nullif(trim(coalesce(p_notes, '')), ''), now())
  on conflict(account_id) do update set opening_date = excluded.opening_date, balance = excluded.balance, notes = excluded.notes, updated_at = now();
  perform public.rebuild_opening_balance_v42(p_account_id);
end;
$$;

create or replace function public.admin_save_accounting_settings_v42(
  p_operator_percent numeric,
  p_reserve_percent numeric,
  p_partner_pool_percent numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare settings_row public.accounting_settings%rowtype;
begin
  perform public.assert_accounting_admin_v42();
  if coalesce(p_operator_percent, 0) + coalesce(p_reserve_percent, 0) > 100 then raise exception 'Operator and reserve percentages cannot exceed 100%% together'; end if;
  insert into public.accounting_settings(id, operator_percent, reserve_percent, partner_pool_percent, updated_at)
  values(true, greatest(p_operator_percent, 0), greatest(p_reserve_percent, 0), greatest(least(p_partner_pool_percent, 100), 0), now())
  on conflict(id) do update set operator_percent = excluded.operator_percent, reserve_percent = excluded.reserve_percent,
    partner_pool_percent = excluded.partner_pool_percent, updated_at = now()
  returning * into settings_row;
  return to_jsonb(settings_row);
end;
$$;

-- Extend the existing application snapshots without duplicating calculated
-- journal lines. Source documents rebuild the ledger after a restore.
create or replace function public.augment_accounting_backup_v42()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object(
    'accounting_accounts', coalesce((select jsonb_agg(to_jsonb(x) order by x.display_order, x.code) from public.accounting_accounts x), '[]'::jsonb),
    'accounting_opening_balances', coalesce((select jsonb_agg(to_jsonb(x) order by x.opening_date, x.id) from public.accounting_opening_balances x), '[]'::jsonb),
    'accounting_settings', coalesce((select jsonb_agg(to_jsonb(x)) from public.accounting_settings x), '[]'::jsonb)
  );
  new.row_counts := coalesce(new.row_counts, '{}'::jsonb) || jsonb_build_object(
    'accounting_accounts', (select count(*) from public.accounting_accounts),
    'accounting_opening_balances', (select count(*) from public.accounting_opening_balances)
  );
  new.schema_version := greatest(coalesce(new.schema_version, 31), 42);
  new.snapshot_size_bytes := pg_column_size(new.snapshot);
  return new;
end;
$$;

drop trigger if exists augment_accounting_backup_v42_trigger on public.app_backups;
create trigger augment_accounting_backup_v42_trigger
before insert or update of snapshot on public.app_backups
for each row execute function public.augment_accounting_backup_v42();

create or replace function public.restore_accounting_backup_v42()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  source_doc record;
  opening_row record;
begin
  if new.status <> 'restored' or old.status = 'restored' or not (new.snapshot ? 'accounting_accounts') then return new; end if;

  delete from public.accounting_journal_entries;
  insert into public.accounting_accounts
  select * from jsonb_populate_recordset(null::public.accounting_accounts, coalesce(new.snapshot -> 'accounting_accounts', '[]'::jsonb))
  on conflict(id) do update set
    code = excluded.code, name = excluded.name, account_type = excluded.account_type,
    statement_section = excluded.statement_section, normal_side = excluded.normal_side,
    system_key = excluded.system_key, is_system = excluded.is_system,
    is_active = excluded.is_active, display_order = excluded.display_order,
    profit_group = excluded.profit_group, updated_at = excluded.updated_at;

  delete from public.accounting_opening_balances;
  insert into public.accounting_opening_balances
  select * from jsonb_populate_recordset(null::public.accounting_opening_balances, coalesce(new.snapshot -> 'accounting_opening_balances', '[]'::jsonb));
  insert into public.accounting_settings
  select * from jsonb_populate_recordset(null::public.accounting_settings, coalesce(new.snapshot -> 'accounting_settings', '[]'::jsonb))
  on conflict(id) do update set operator_percent = excluded.operator_percent,
    reserve_percent = excluded.reserve_percent, partner_pool_percent = excluded.partner_pool_percent,
    updated_at = excluded.updated_at;

  for opening_row in select account_id from public.accounting_opening_balances loop
    perform public.rebuild_opening_balance_v42(opening_row.account_id);
  end loop;
  for source_doc in select id from public.documents order by created_at, id loop
    perform public.sync_accounting_document_v42(source_doc.id);
  end loop;
  perform public.reconcile_inventory_ledger_v42();
  perform public.reconcile_party_ledger_v42();
  return new;
end;
$$;

drop trigger if exists restore_accounting_backup_v42_trigger on public.app_backups;
create trigger restore_accounting_backup_v42_trigger
after update of status on public.app_backups
for each row execute function public.restore_accounting_backup_v42();

-- Build the ledger for records already present when this migration is installed.
do $$
declare source_doc record;
begin
  for source_doc in select id from public.documents order by created_at, id loop
    perform public.sync_accounting_document_v42(source_doc.id);
  end loop;
  perform public.reconcile_inventory_ledger_v42();
  perform public.reconcile_party_ledger_v42();
end
$$;

revoke all on function public.assert_accounting_admin_v42() from public;
revoke all on function public.accounting_account_id_v42(text) from public;
revoke all on function public.ensure_payment_account_v42(uuid) from public;
revoke all on function public.add_accounting_line_v42(uuid, uuid, numeric, numeric, text) from public;
revoke all on function public.sync_accounting_document_v42(uuid) from public;
revoke all on function public.rebuild_opening_balance_v42(uuid) from public;
revoke all on function public.reconcile_inventory_ledger_v42() from public;
revoke all on function public.reconcile_party_ledger_v42() from public;
revoke all on function public.get_accounting_report_v42(date, date, date) from public;
revoke all on function public.save_accounting_cash_document_v42(text, uuid, uuid, numeric, text, date) from public;
revoke all on function public.admin_save_account_v42(uuid, text, text, text, text, text, text) from public;
revoke all on function public.admin_save_opening_balance_v42(uuid, numeric, date, text) from public;
revoke all on function public.admin_save_accounting_settings_v42(numeric, numeric, numeric) from public;
revoke all on function public.augment_accounting_backup_v42() from public;
revoke all on function public.restore_accounting_backup_v42() from public;

grant execute on function public.get_accounting_report_v42(date, date, date) to authenticated;
grant execute on function public.save_accounting_cash_document_v42(text, uuid, uuid, numeric, text, date) to authenticated;
grant execute on function public.admin_save_account_v42(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_save_opening_balance_v42(uuid, numeric, date, text) to authenticated;
grant execute on function public.admin_save_accounting_settings_v42(numeric, numeric, numeric) to authenticated;

do $$
declare table_name text;
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['accounting_accounts', 'accounting_journal_entries', 'accounting_journal_lines', 'accounting_opening_balances', 'accounting_settings'] loop
      if not exists(
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
