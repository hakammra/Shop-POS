-- v56: WhatsApp-ready sales, minimum-profit protection, cheque records and daily register reconciliation.
-- Run once after 055_two_letter_party_codes.sql.

begin;

alter table public.app_settings
  add column if not exists minimum_profit_percent numeric(6,2) not null default 5
  check (minimum_profit_percent between 0 and 1000);

alter table public.payment_methods
  add column if not exists requires_cheque_details boolean not null default false;

insert into public.payment_methods(name, affects_cashflow, is_active, is_paid_method, account_kind, requires_cheque_details)
values ('Cheque', true, true, true, 'bank', true)
on conflict (name) do update set
  affects_cashflow = true,
  is_paid_method = true,
  account_kind = 'bank',
  requires_cheque_details = true;

create table if not exists public.cheque_payments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  payment_method_id uuid not null references public.payment_methods(id),
  source_line_id text not null,
  direction text not null check (direction in ('in', 'out')),
  amount numeric(12,2) not null check (amount > 0),
  cheque_number text not null,
  cheque_date date not null,
  bank_name text,
  status text not null default 'received' check (status in ('received', 'issued', 'deposited', 'cleared', 'bounced', 'cancelled')),
  notes text,
  created_by_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(document_id, source_line_id)
);

alter table public.cheque_payments drop constraint if exists cheque_payments_status_check;
alter table public.cheque_payments add constraint cheque_payments_status_check
  check (status in ('received', 'issued', 'deposited', 'cleared', 'bounced', 'cancelled'));

create index if not exists cheque_payments_date_idx on public.cheque_payments(cheque_date, status);
create index if not exists cheque_payments_document_idx on public.cheque_payments(document_id);

alter table public.cheque_payments enable row level security;
revoke all on public.cheque_payments from anon, authenticated;
grant select on public.cheque_payments to authenticated;

drop policy if exists "authenticated read cheque payments v56" on public.cheque_payments;
create policy "authenticated read cheque payments v56"
  on public.cheque_payments for select to authenticated using (true);

create table if not exists public.register_shifts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.trusted_pos_devices(id),
  opened_by_staff_id uuid not null references public.staff(id),
  closed_by_staff_id uuid references public.staff(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_cash numeric(12,2) not null check (opening_cash >= 0),
  expected_cash numeric(12,2),
  counted_cash numeric(12,2),
  variance numeric(12,2),
  opening_note text,
  closing_note text,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists register_shifts_one_open_per_device_idx
  on public.register_shifts(device_id) where status = 'open';
create index if not exists register_shifts_opened_at_idx on public.register_shifts(opened_at desc);

alter table public.register_shifts enable row level security;
revoke all on public.register_shifts from anon, authenticated;

alter table public.cashflow_entries
  add column if not exists register_shift_id uuid references public.register_shifts(id) on delete set null;
create index if not exists cashflow_entries_register_shift_idx on public.cashflow_entries(register_shift_id);

create or replace function public.current_pos_device_id_v56()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select os.device_id
  from public.pos_operator_sessions os
  where os.auth_session_id = public.pos_auth_session_id_v38()
    and os.auth_user_id = auth.uid()
    and os.expires_at > now()
  limit 1;
$$;

create or replace function public.assign_open_register_shift_v56()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare current_device_id uuid; open_shift_id uuid;
begin
  if new.register_shift_id is not null then return new; end if;
  current_device_id := public.current_pos_device_id_v56();
  if current_device_id is null then return new; end if;
  select rs.id into open_shift_id
  from public.register_shifts rs
  where rs.device_id = current_device_id and rs.status = 'open'
  order by rs.opened_at desc limit 1;
  new.register_shift_id := open_shift_id;
  return new;
end;
$$;

drop trigger if exists cashflow_assign_open_register_v56 on public.cashflow_entries;
create trigger cashflow_assign_open_register_v56
before insert on public.cashflow_entries
for each row execute function public.assign_open_register_shift_v56();

create or replace function public.validate_cheque_payments_v56(p_payments jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare pay jsonb; requires_details boolean;
begin
  for pay in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    select coalesce(pm.requires_cheque_details, false) into requires_details
    from public.payment_methods pm where pm.id = nullif(pay ->> 'payment_method_id', '')::uuid;
    if requires_details then
      if nullif(trim(coalesce(pay ->> 'cheque_number', '')), '') is null then raise exception 'Cheque number is required'; end if;
      if nullif(pay ->> 'cheque_date', '') is null then raise exception 'Cheque date is required'; end if;
      perform (pay ->> 'cheque_date')::date;
    end if;
  end loop;
end;
$$;

create or replace function public.record_cheque_payments_v56(p_document_id uuid, p_payments jsonb, p_default_direction text default 'in')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare pay jsonb; pm record;
begin
  perform public.validate_cheque_payments_v56(p_payments);
  for pay in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    select * into pm from public.payment_methods where id = nullif(pay ->> 'payment_method_id', '')::uuid;
    if coalesce(pm.requires_cheque_details, false) then
      insert into public.cheque_payments(
        document_id, payment_method_id, source_line_id, direction, amount,
        cheque_number, cheque_date, bank_name, status, created_by_staff_id
      ) values (
        p_document_id, pm.id, coalesce(nullif(pay ->> 'source_line_id', ''), gen_random_uuid()::text),
        coalesce(nullif(pay ->> 'direction', ''), p_default_direction),
        (pay ->> 'amount')::numeric, trim(pay ->> 'cheque_number'), (pay ->> 'cheque_date')::date,
        nullif(trim(coalesce(pay ->> 'cheque_bank_name', '')), ''),
        case when coalesce(nullif(pay ->> 'direction', ''), p_default_direction) = 'out' then 'issued' else 'received' end,
        public.current_pos_staff_id_v38()
      ) on conflict(document_id, source_line_id) do update set
        amount = excluded.amount, direction = excluded.direction, cheque_number = excluded.cheque_number,
        cheque_date = excluded.cheque_date, bank_name = excluded.bank_name, updated_at = now();
    end if;
  end loop;
end;
$$;

create or replace function public.validate_pos_minimum_profit_v56(p_header jsonb, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  margin_percent numeric := 5;
  positive_subtotal numeric := 0;
  cart_discount numeric := 0;
  discount_factor numeric := 1;
  item jsonb;
  product_row record;
  qty numeric;
  unit_price numeric;
  line_discount numeric;
  line_net numeric;
  effective_unit numeric;
  minimum_unit numeric;
begin
  select coalesce(s.minimum_profit_percent, 5) into margin_percent from public.app_settings s where s.id = true;
  if margin_percent <= 0 then return; end if;

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    qty := coalesce((item ->> 'qty')::numeric, 0);
    if qty <= 0 then continue; end if;
    unit_price := coalesce((item ->> 'unit_price')::numeric, 0);
    line_discount := case coalesce(item ->> 'discount_type', 'none')
      when 'percent' then qty * unit_price * coalesce((item ->> 'discount_value')::numeric, 0) / 100
      when 'amount' then coalesce((item ->> 'discount_value')::numeric, 0)
      else 0 end;
    positive_subtotal := positive_subtotal + greatest(qty * unit_price - line_discount, 0);
  end loop;

  if positive_subtotal > 0 then
    cart_discount := case coalesce(p_header ->> 'cart_discount_type', 'amount')
      when 'percent' then positive_subtotal * coalesce((p_header ->> 'cart_discount_value')::numeric, 0) / 100
      else greatest(coalesce((p_header ->> 'cart_discount_value')::numeric, 0), 0) end;
    discount_factor := greatest(positive_subtotal - least(cart_discount, positive_subtotal), 0) / positive_subtotal;
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    qty := coalesce((item ->> 'qty')::numeric, 0);
    if qty <= 0 then continue; end if;
    select p.id, p.item_code, p.name, coalesce(p.avg_cost, 0) avg_cost into product_row
    from public.products p where p.id = nullif(item ->> 'product_id', '')::uuid;
    if not found or product_row.avg_cost <= 0 then continue; end if;
    unit_price := coalesce((item ->> 'unit_price')::numeric, 0);
    line_discount := case coalesce(item ->> 'discount_type', 'none')
      when 'percent' then qty * unit_price * coalesce((item ->> 'discount_value')::numeric, 0) / 100
      when 'amount' then coalesce((item ->> 'discount_value')::numeric, 0)
      else 0 end;
    line_net := greatest(qty * unit_price - line_discount, 0) * discount_factor;
    effective_unit := line_net / qty;
    minimum_unit := product_row.avg_cost * (1 + margin_percent / 100);
    if effective_unit + 0.005 < minimum_unit then
      raise exception '% (%) cannot be sold below LKR % after discounts (% profit over cost)',
        product_row.name, product_row.item_code, round(minimum_unit, 2), margin_percent;
    end if;
  end loop;
end;
$$;

create or replace function public.save_pos_invoice_v56(p_header jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.validate_pos_minimum_profit_v56(p_header, p_items);
  perform public.validate_cheque_payments_v56(p_payments);
  result := public.save_pos_invoice_v41(p_header, p_items, p_payments);
  perform public.record_cheque_payments_v56((result ->> 'id')::uuid, p_payments, case when coalesce((p_header ->> 'total_amount')::numeric, 0) < 0 then 'out' else 'in' end);
  return result;
end;
$$;

create or replace function public.save_purchase_like_document_v56(p_header jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.validate_cheque_payments_v56(p_payments);
  result := public.save_purchase_like_document_v18(p_header, p_items, p_payments);
  perform public.record_cheque_payments_v56((result ->> 'id')::uuid, p_payments, 'out');
  return result;
end;
$$;

create or replace function public.replace_purchase_like_document_v56(p_document_id uuid, p_header jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
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

create or replace function public.save_party_payment_v56(
  p_profile_id uuid, p_document_type text, p_payment_method_id uuid, p_amount numeric,
  p_direction text default 'in', p_note text default null, p_cheque_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb; payments jsonb;
begin
  payments := jsonb_build_array(jsonb_build_object(
    'source_line_id', coalesce(nullif(p_cheque_details ->> 'source_line_id', ''), gen_random_uuid()::text),
    'payment_method_id', p_payment_method_id, 'amount', p_amount, 'direction', p_direction,
    'cheque_number', p_cheque_details ->> 'cheque_number', 'cheque_date', p_cheque_details ->> 'cheque_date',
    'cheque_bank_name', p_cheque_details ->> 'cheque_bank_name'
  ));
  perform public.validate_cheque_payments_v56(payments);
  result := public.save_party_payment_v29(p_profile_id, p_document_type, p_payment_method_id, p_amount, p_direction, p_note);
  perform public.record_cheque_payments_v56((result ->> 'document_id')::uuid, payments, p_direction);
  return result;
end;
$$;

create or replace function public.register_shift_json_v56(p_shift_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(x) from (
    select rs.*,
      os.full_name opened_by_name, cs.full_name closed_by_name,
      coalesce((select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
        from public.cashflow_entries cf join public.payment_methods pm on pm.id = cf.payment_method_id
        where pm.account_kind = 'cash' and cf.register_shift_id = rs.id), 0) cash_movement,
      rs.opening_cash + coalesce((select sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end)
        from public.cashflow_entries cf join public.payment_methods pm on pm.id = cf.payment_method_id
        where pm.account_kind = 'cash' and cf.register_shift_id = rs.id), 0) live_expected_cash
    from public.register_shifts rs
    join public.staff os on os.id = rs.opened_by_staff_id
    left join public.staff cs on cs.id = rs.closed_by_staff_id
    where rs.id = p_shift_id
  ) x;
$$;

create or replace function public.get_register_state_v56()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare current_device_id uuid; shift_id uuid; history jsonb;
begin
  current_device_id := public.current_pos_device_id_v56();
  if current_device_id is null then raise exception 'Unlock this trusted POS device first'; end if;
  select rs.id into shift_id from public.register_shifts rs where rs.device_id = current_device_id and rs.status = 'open' order by rs.opened_at desc limit 1;
  select coalesce(jsonb_agg(public.register_shift_json_v56(h.id) order by h.opened_at desc), '[]'::jsonb) into history
  from (select rs.id, rs.opened_at from public.register_shifts rs where rs.device_id = current_device_id order by rs.opened_at desc limit 14) h;
  return jsonb_build_object('current', case when shift_id is null then null else public.register_shift_json_v56(shift_id) end, 'history', history);
end;
$$;

create or replace function public.open_register_v56(p_opening_cash numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare current_device_id uuid; staff_id uuid; shift_id uuid;
begin
  staff_id := public.current_pos_staff_id_v38(); current_device_id := public.current_pos_device_id_v56();
  if staff_id is null or current_device_id is null then raise exception 'Unlock this trusted POS device first'; end if;
  if coalesce(p_opening_cash, -1) < 0 then raise exception 'Opening cash cannot be negative'; end if;
  if exists(select 1 from public.register_shifts rs where rs.device_id = current_device_id and rs.status = 'open') then raise exception 'This register is already open'; end if;
  insert into public.register_shifts(device_id, opened_by_staff_id, opening_cash, opening_note)
  values(current_device_id, staff_id, round(p_opening_cash, 2), nullif(trim(p_note), '')) returning id into shift_id;
  return public.register_shift_json_v56(shift_id);
end;
$$;

create or replace function public.close_register_v56(p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare current_device_id uuid; staff_id uuid; shift_row public.register_shifts%rowtype; movement numeric; expected numeric;
begin
  staff_id := public.current_pos_staff_id_v38(); current_device_id := public.current_pos_device_id_v56();
  if staff_id is null or current_device_id is null then raise exception 'Unlock this trusted POS device first'; end if;
  if coalesce(p_counted_cash, -1) < 0 then raise exception 'Counted cash cannot be negative'; end if;
  select rs.* into shift_row from public.register_shifts rs where rs.device_id = current_device_id and rs.status = 'open' for update;
  if not found then raise exception 'There is no open register on this device'; end if;
  select coalesce(sum(case when cf.entry_type = 'cash_in' then cf.amount when cf.entry_type = 'cash_out' then -cf.amount else 0 end), 0)
  into movement from public.cashflow_entries cf join public.payment_methods pm on pm.id = cf.payment_method_id
  where pm.account_kind = 'cash' and cf.register_shift_id = shift_row.id;
  expected := round(shift_row.opening_cash + movement, 2);
  update public.register_shifts set status = 'closed', closed_at = now(), closed_by_staff_id = staff_id,
    expected_cash = expected, counted_cash = round(p_counted_cash, 2), variance = round(p_counted_cash - expected, 2),
    closing_note = nullif(trim(p_note), ''), updated_at = now() where id = shift_row.id;
  return public.register_shift_json_v56(shift_row.id);
end;
$$;

create or replace function public.admin_save_app_settings_v41(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  admin_id uuid;
  payment_id uuid := nullif(p_settings ->> 'default_payment_method_id', '')::uuid;
  lock_minutes integer := greatest(1, least(coalesce((p_settings ->> 'auto_lock_minutes')::integer, 5), 240));
  margin_percent numeric := greatest(0, least(coalesce((p_settings ->> 'minimum_profit_percent')::numeric, 5), 1000));
  settings_row public.app_settings%rowtype;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff s where s.id = admin_id and s.role = 'admin' and s.is_active) then raise exception 'Only an active admin can change application settings'; end if;
  if payment_id is not null and not exists(select 1 from public.payment_methods p where p.id = payment_id and p.is_active) then raise exception 'The preferred payment method is not active'; end if;
  insert into public.app_settings(id, allow_negative_pos_stock, show_pos_stock_badges, confirm_pos_sale, default_payment_method_id, minimum_profit_percent, updated_at)
  values(true, coalesce((p_settings ->> 'allow_negative_pos_stock')::boolean, false), coalesce((p_settings ->> 'show_pos_stock_badges')::boolean, true),
    coalesce((p_settings ->> 'confirm_pos_sale')::boolean, false), payment_id, margin_percent, now())
  on conflict(id) do update set allow_negative_pos_stock = excluded.allow_negative_pos_stock,
    show_pos_stock_badges = excluded.show_pos_stock_badges, confirm_pos_sale = excluded.confirm_pos_sale,
    default_payment_method_id = excluded.default_payment_method_id, minimum_profit_percent = excluded.minimum_profit_percent, updated_at = now()
  returning * into settings_row;
  insert into public.pos_security_settings(id, auto_lock_minutes, updated_at) values(true, lock_minutes, now())
  on conflict(id) do update set auto_lock_minutes = excluded.auto_lock_minutes, updated_at = now();
  return to_jsonb(settings_row);
end;
$$;

revoke all on function public.save_pos_invoice_v56(jsonb, jsonb, jsonb) from public;
revoke all on function public.save_purchase_like_document_v56(jsonb, jsonb, jsonb) from public;
revoke all on function public.replace_purchase_like_document_v56(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.save_party_payment_v56(uuid, text, uuid, numeric, text, text, jsonb) from public;
revoke all on function public.get_register_state_v56() from public;
revoke all on function public.open_register_v56(numeric, text) from public;
revoke all on function public.close_register_v56(numeric, text) from public;
grant execute on function public.save_pos_invoice_v56(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.save_purchase_like_document_v56(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_purchase_like_document_v56(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.save_party_payment_v56(uuid, text, uuid, numeric, text, text, jsonb) to authenticated;
grant execute on function public.get_register_state_v56() to authenticated;
grant execute on function public.open_register_v56(numeric, text) to authenticated;
grant execute on function public.close_register_v56(numeric, text) to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cheque_payments') then alter publication supabase_realtime add table public.cheque_payments; end if;
    if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'register_shifts') then alter publication supabase_realtime add table public.register_shifts; end if;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
