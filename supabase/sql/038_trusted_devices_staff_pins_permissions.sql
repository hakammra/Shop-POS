-- Trusted POS devices, 4-digit staff PIN unlock, permissions, and operator audit.
-- Run after 037_non_stock_products.sql.

begin;

create extension if not exists pgcrypto;

do $$
declare
  constraint_name text;
begin
  select c.conname into constraint_name
  from pg_constraint c
  where c.conrelid = 'public.staff'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%role%'
  limit 1;
  if constraint_name is not null then
    execute format('alter table public.staff drop constraint %I', constraint_name);
  end if;
end $$;

-- Keep only two roles. Existing manager/cashier rows become staff after the old
-- three-role check constraint has been removed.
update public.staff set role = 'staff' where role <> 'admin';

alter table public.staff
  alter column role set default 'staff',
  add column if not exists pin_hash text,
  add column if not exists permissions jsonb not null default '{}'::jsonb,
  add column if not exists failed_pin_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.staff
  add constraint staff_role_v38_check check (role in ('admin', 'staff'));

create table if not exists public.pos_security_settings (
  id boolean primary key default true check (id = true),
  auto_lock_minutes integer not null default 5 check (auto_lock_minutes between 1 and 120),
  max_pin_attempts integer not null default 5 check (max_pin_attempts between 3 and 10),
  pin_lock_minutes integer not null default 1 check (pin_lock_minutes between 1 and 60),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff(id) on delete set null
);

insert into public.pos_security_settings (id) values (true)
on conflict (id) do nothing;

create table if not exists public.trusted_pos_devices (
  id uuid primary key default gen_random_uuid(),
  device_token_hash text not null unique,
  device_name text not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  trusted_by_staff_id uuid references public.staff(id) on delete set null,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.pos_operator_sessions (
  auth_session_id uuid primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.trusted_pos_devices(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists pos_operator_sessions_staff_idx on public.pos_operator_sessions(staff_id);
create index if not exists pos_operator_sessions_expiry_idx on public.pos_operator_sessions(expires_at);

alter table public.trusted_pos_devices enable row level security;
alter table public.pos_operator_sessions enable row level security;
alter table public.pos_security_settings enable row level security;

-- These security tables are accessible only through the functions below.
revoke all on public.trusted_pos_devices from anon, authenticated;
revoke all on public.pos_operator_sessions from anon, authenticated;
revoke all on public.pos_security_settings from anon, authenticated;

drop policy if exists "dev authenticated all staff" on public.staff;
revoke all on public.staff from anon, authenticated;

create or replace function public.pos_auth_session_id_v38()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

create or replace function public.pos_device_hash_v38(p_device_token text)
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select encode(digest(coalesce(p_device_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.current_pos_staff_id_v38()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select os.staff_id
  from public.pos_operator_sessions os
  join public.trusted_pos_devices d on d.id = os.device_id and d.is_active
  join public.staff s on s.id = os.staff_id and s.is_active
  where os.auth_session_id = public.pos_auth_session_id_v38()
    and os.auth_user_id = auth.uid()
    and os.expires_at > now()
  limit 1;
$$;

create or replace function public.has_pos_permission_v38(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce((s.role = 'admin') or coalesce((s.permissions ->> p_permission)::boolean, false), false)
  from public.staff s
  where s.id = public.current_pos_staff_id_v38();
$$;

create or replace function public.pos_staff_json_v38(p_staff_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'full_name', s.full_name,
    'role', s.role,
    'permissions', case when s.role = 'admin' then '{}'::jsonb else coalesce(s.permissions, '{}'::jsonb) end,
    'is_active', s.is_active
  )
  from public.staff s
  where s.id = p_staff_id;
$$;

create or replace function public.get_pos_security_state_v38(p_device_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  linked_admin public.staff%rowtype;
  device_row public.trusted_pos_devices%rowtype;
  operator_id uuid;
  settings_row public.pos_security_settings%rowtype;
  has_linked_admin boolean;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;

  select exists(select 1 from public.staff where role = 'admin' and auth_user_id is not null)
  into has_linked_admin;
  select * into settings_row from public.pos_security_settings where id = true;

  if not has_linked_admin then
    return jsonb_build_object(
      'setup_required', true,
      'device_trusted', false,
      'auto_lock_minutes', coalesce(settings_row.auto_lock_minutes, 5)
    );
  end if;

  select * into linked_admin
  from public.staff
  where auth_user_id = auth.uid() and role = 'admin' and is_active
  limit 1;

  select * into device_row
  from public.trusted_pos_devices
  where device_token_hash = public.pos_device_hash_v38(p_device_token)
    and auth_user_id = auth.uid()
    and is_active
  limit 1;

  if device_row.id is null then
    return jsonb_build_object(
      'setup_required', false,
      'device_trusted', false,
      'can_trust_device', linked_admin.id is not null,
      'admin_pin_required', linked_admin.id is not null and linked_admin.pin_hash is null,
      'auto_lock_minutes', coalesce(settings_row.auto_lock_minutes, 5)
    );
  end if;

  update public.trusted_pos_devices set last_seen_at = now() where id = device_row.id;
  operator_id := public.current_pos_staff_id_v38();

  return jsonb_build_object(
    'setup_required', false,
    'device_trusted', true,
    'device_id', device_row.id,
    'device_name', device_row.device_name,
    'auto_lock_minutes', coalesce(settings_row.auto_lock_minutes, 5),
    'active_staff', case when operator_id is null then null else public.pos_staff_json_v38(operator_id) end
  );
end;
$$;

create or replace function public.bootstrap_pos_security_v38(
  p_full_name text,
  p_pin text,
  p_device_token text,
  p_device_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  admin_row public.staff%rowtype;
  device_row public.trusted_pos_devices%rowtype;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must contain exactly 4 numbers'; end if;
  if exists(select 1 from public.staff where role = 'admin' and auth_user_id is not null) then
    raise exception 'Security setup is already complete';
  end if;

  select * into admin_row from public.staff where role = 'admin' and auth_user_id is null order by created_at limit 1 for update;
  if admin_row.id is null then
    insert into public.staff (auth_user_id, full_name, role, is_active, pin_hash)
    values (auth.uid(), coalesce(nullif(trim(p_full_name), ''), split_part(coalesce(auth.jwt() ->> 'email', 'Owner'), '@', 1)), 'admin', true, crypt(p_pin, gen_salt('bf', 10)))
    returning * into admin_row;
  else
    update public.staff
    set auth_user_id = auth.uid(),
        full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
        is_active = true,
        pin_hash = crypt(p_pin, gen_salt('bf', 10)),
        updated_at = now()
    where id = admin_row.id returning * into admin_row;
  end if;

  insert into public.trusted_pos_devices (device_token_hash, device_name, auth_user_id, trusted_by_staff_id)
  values (public.pos_device_hash_v38(p_device_token), left(coalesce(nullif(trim(p_device_name), ''), 'POS device'), 120), auth.uid(), admin_row.id)
  on conflict (device_token_hash) do update
    set device_name = excluded.device_name,
        auth_user_id = excluded.auth_user_id,
        trusted_by_staff_id = excluded.trusted_by_staff_id,
        is_active = true,
        last_seen_at = now()
  returning * into device_row;

  return jsonb_build_object('device_trusted', true, 'staff', public.pos_staff_json_v38(admin_row.id));
end;
$$;

create or replace function public.trust_current_pos_device_v38(
  p_device_token text,
  p_device_name text,
  p_admin_pin text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  admin_row public.staff%rowtype;
  device_row public.trusted_pos_devices%rowtype;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  select * into admin_row from public.staff where auth_user_id = auth.uid() and role = 'admin' and is_active limit 1 for update;
  if admin_row.id is null then raise exception 'Only an active admin login can trust a new device'; end if;

  if admin_row.pin_hash is null then
    if coalesce(p_admin_pin, '') !~ '^[0-9]{4}$' then raise exception 'Set your 4-digit admin PIN first'; end if;
    update public.staff set pin_hash = crypt(p_admin_pin, gen_salt('bf', 10)), updated_at = now() where id = admin_row.id;
  end if;

  insert into public.trusted_pos_devices (device_token_hash, device_name, auth_user_id, trusted_by_staff_id)
  values (public.pos_device_hash_v38(p_device_token), left(coalesce(nullif(trim(p_device_name), ''), 'POS device'), 120), auth.uid(), admin_row.id)
  on conflict (device_token_hash) do update
    set device_name = excluded.device_name,
        auth_user_id = excluded.auth_user_id,
        trusted_by_staff_id = excluded.trusted_by_staff_id,
        is_active = true,
        last_seen_at = now()
  returning * into device_row;

  return jsonb_build_object('device_trusted', true, 'device_id', device_row.id);
end;
$$;

create or replace function public.list_pos_unlock_staff_v38(p_device_token text)
returns table(id uuid, full_name text, role text)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not exists(
    select 1 from public.trusted_pos_devices d
    where d.device_token_hash = public.pos_device_hash_v38(p_device_token)
      and d.auth_user_id = auth.uid() and d.is_active
  ) then raise exception 'This browser is not a trusted POS device'; end if;

  return query
  select s.id, s.full_name, s.role
  from public.staff s
  where s.is_active and s.pin_hash is not null
  order by case when s.role = 'admin' then 0 else 1 end, s.full_name;
end;
$$;

create or replace function public.unlock_pos_staff_v38(p_device_token text, p_staff_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  staff_row public.staff%rowtype;
  device_row public.trusted_pos_devices%rowtype;
  settings_row public.pos_security_settings%rowtype;
  session_id uuid;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'Enter a 4-digit PIN'; end if;
  session_id := public.pos_auth_session_id_v38();
  if session_id is null then raise exception 'Could not identify this login session'; end if;

  select * into device_row from public.trusted_pos_devices
  where device_token_hash = public.pos_device_hash_v38(p_device_token)
    and auth_user_id = auth.uid() and is_active limit 1;
  if device_row.id is null then raise exception 'This browser is not a trusted POS device'; end if;

  select * into staff_row from public.staff where id = p_staff_id and is_active for update;
  if staff_row.id is null or staff_row.pin_hash is null then raise exception 'Staff member is unavailable'; end if;
  if staff_row.pin_locked_until is not null and staff_row.pin_locked_until > now() then
    raise exception 'Too many incorrect attempts. Try again after %', to_char(staff_row.pin_locked_until, 'HH12:MI:SS AM');
  end if;
  select * into settings_row from public.pos_security_settings where id = true;

  if crypt(p_pin, staff_row.pin_hash) <> staff_row.pin_hash then
    update public.staff
    set failed_pin_attempts = failed_pin_attempts + 1,
        pin_locked_until = case when failed_pin_attempts + 1 >= coalesce(settings_row.max_pin_attempts, 5)
          then now() + make_interval(mins => coalesce(settings_row.pin_lock_minutes, 1)) else null end,
        updated_at = now()
    where id = staff_row.id;
    raise exception 'Incorrect PIN';
  end if;

  update public.staff set failed_pin_attempts = 0, pin_locked_until = null, updated_at = now() where id = staff_row.id;
  insert into public.pos_operator_sessions (auth_session_id, auth_user_id, device_id, staff_id, expires_at)
  values (session_id, auth.uid(), device_row.id, staff_row.id, now() + make_interval(mins => coalesce(settings_row.auto_lock_minutes, 5)))
  on conflict (auth_session_id) do update
    set device_id = excluded.device_id,
        staff_id = excluded.staff_id,
        unlocked_at = now(),
        last_activity_at = now(),
        expires_at = excluded.expires_at;
  update public.trusted_pos_devices set last_seen_at = now() where id = device_row.id;

  return public.pos_staff_json_v38(staff_row.id);
end;
$$;

create or replace function public.touch_pos_staff_session_v38()
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  new_expiry timestamptz;
  lock_minutes integer;
begin
  select auto_lock_minutes into lock_minutes from public.pos_security_settings where id = true;
  new_expiry := now() + make_interval(mins => coalesce(lock_minutes, 5));
  update public.pos_operator_sessions
  set last_activity_at = now(), expires_at = new_expiry
  where auth_session_id = public.pos_auth_session_id_v38() and auth_user_id = auth.uid();
  if not found then raise exception 'POS is locked'; end if;
  return new_expiry;
end;
$$;

create or replace function public.lock_pos_staff_session_v38()
returns void
language sql
security definer
set search_path = public, auth
as $$
  delete from public.pos_operator_sessions
  where auth_session_id = public.pos_auth_session_id_v38() and auth_user_id = auth.uid();
$$;

create or replace function public.admin_list_staff_v38()
returns table(id uuid, full_name text, role text, is_active boolean, permissions jsonb, has_pin boolean, auth_email text, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.has_pos_permission_v38('__admin__') then
    if not exists(select 1 from public.staff admin_staff where admin_staff.id = public.current_pos_staff_id_v38() and admin_staff.role = 'admin') then
      raise exception 'Admin PIN required';
    end if;
  end if;
  return query
  select s.id, s.full_name, s.role, s.is_active, coalesce(s.permissions, '{}'::jsonb), s.pin_hash is not null,
         u.email::text, s.created_at, s.updated_at
  from public.staff s left join auth.users u on u.id = s.auth_user_id
  order by case when s.role = 'admin' then 0 else 1 end, s.full_name;
end;
$$;

create or replace function public.admin_save_staff_v38(
  p_staff_id uuid,
  p_full_name text,
  p_role text,
  p_permissions jsonb,
  p_pin text default null,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  current_admin uuid;
  target public.staff%rowtype;
begin
  current_admin := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff where id = current_admin and role = 'admin' and is_active) then raise exception 'Admin PIN required'; end if;
  if nullif(trim(p_full_name), '') is null then raise exception 'Staff name is required'; end if;
  if p_role not in ('admin', 'staff') then raise exception 'Role must be admin or staff'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must contain exactly 4 numbers'; end if;
  if p_pin is not null and exists(select 1 from public.staff s where s.id is distinct from p_staff_id and s.is_active and s.pin_hash is not null and crypt(p_pin, s.pin_hash) = s.pin_hash) then
    raise exception 'That PIN is already assigned to another active user';
  end if;

  if p_staff_id is null then
    if p_pin is null then raise exception 'Set a 4-digit PIN for the new user'; end if;
    insert into public.staff (full_name, role, permissions, pin_hash, is_active)
    values (trim(p_full_name), p_role, coalesce(p_permissions, '{}'::jsonb), crypt(p_pin, gen_salt('bf', 10)), p_is_active)
    returning * into target;
  else
    select * into target from public.staff where id = p_staff_id for update;
    if target.id is null then raise exception 'Staff member not found'; end if;
    if target.id = current_admin and (p_role <> 'admin' or not p_is_active) then
      raise exception 'Switch to another admin before changing or deactivating the currently active admin';
    end if;
    if target.role = 'admin' and (p_role <> 'admin' or not p_is_active)
       and (select count(*) from public.staff where role = 'admin' and is_active and id <> target.id) = 0 then
      raise exception 'The last active admin cannot be deactivated or changed to staff';
    end if;
    update public.staff
    set full_name = trim(p_full_name),
        role = p_role,
        permissions = coalesce(p_permissions, '{}'::jsonb),
        is_active = p_is_active,
        pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 10)) end,
        failed_pin_attempts = case when p_pin is null then failed_pin_attempts else 0 end,
        pin_locked_until = case when p_pin is null then pin_locked_until else null end,
        updated_at = now()
    where id = target.id returning * into target;
  end if;
  return public.pos_staff_json_v38(target.id);
end;
$$;

create or replace function public.admin_update_pos_security_v38(p_auto_lock_minutes integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare admin_id uuid;
begin
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff admin_staff where admin_staff.id = admin_id and admin_staff.role = 'admin' and admin_staff.is_active) then raise exception 'Admin PIN required'; end if;
  if p_auto_lock_minutes < 1 or p_auto_lock_minutes > 120 then raise exception 'Auto-lock must be between 1 and 120 minutes'; end if;
  update public.pos_security_settings set auto_lock_minutes = p_auto_lock_minutes, updated_at = now(), updated_by = admin_id where id = true;
  return jsonb_build_object('auto_lock_minutes', p_auto_lock_minutes);
end;
$$;

create or replace function public.admin_list_trusted_devices_v38()
returns table(id uuid, device_name text, is_active boolean, last_seen_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare admin_id uuid;
begin
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff admin_staff where admin_staff.id = admin_id and admin_staff.role = 'admin' and admin_staff.is_active) then raise exception 'Admin PIN required'; end if;
  return query select d.id, d.device_name, d.is_active, d.last_seen_at, d.created_at from public.trusted_pos_devices d order by d.last_seen_at desc;
end;
$$;

create or replace function public.admin_set_trusted_device_active_v38(p_device_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare admin_id uuid;
begin
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff where id = admin_id and role = 'admin' and is_active) then raise exception 'Admin PIN required'; end if;
  update public.trusted_pos_devices set is_active = p_is_active where id = p_device_id;
  if not p_is_active then delete from public.pos_operator_sessions where device_id = p_device_id; end if;
end;
$$;

-- Safe staff directory for order-taker and other operational selectors.
create or replace view public.staff_directory_v38 as
select id, auth_user_id, full_name, role, is_active, created_at, updated_at
from public.staff;
grant select on public.staff_directory_v38 to authenticated;

-- Record which unlocked operator created or last changed each document.
alter table public.documents
  add column if not exists created_by_staff_id uuid references public.staff(id) on delete set null,
  add column if not exists updated_by_staff_id uuid references public.staff(id) on delete set null;

create or replace function public.audit_document_operator_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare operator_id uuid;
declare needed_permission text;
begin
  -- Scheduled Edge Functions use the service role and do not represent a human
  -- POS operator (for example, automatic SLPOST tracking updates).
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
    when 'refund' then 'process_returns'
    else 'view_documents'
  end;
  if not public.has_pos_permission_v38(needed_permission) then raise exception 'The active user does not have permission for this document action'; end if;

  if tg_op = 'INSERT' then new.created_by_staff_id := coalesce(new.created_by_staff_id, operator_id); end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

drop trigger if exists documents_operator_audit_v38 on public.documents;
create trigger documents_operator_audit_v38 before insert or update or delete on public.documents
for each row execute function public.audit_document_operator_v38();

create or replace function public.guard_product_write_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('manage_products') then raise exception 'You do not have permission to change products'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists products_permission_v38 on public.products;
create trigger products_permission_v38 before insert or update or delete on public.products
for each row execute function public.guard_product_write_v38();

create or replace function public.guard_admin_write_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not exists(select 1 from public.staff where id = public.current_pos_staff_id_v38() and role = 'admin' and is_active) then
    raise exception 'Only an admin can change this setting';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists company_settings_admin_v38 on public.company_settings;
create trigger company_settings_admin_v38 before insert or update or delete on public.company_settings
for each row execute function public.guard_admin_write_v38();

drop trigger if exists payment_methods_admin_v38 on public.payment_methods;
create trigger payment_methods_admin_v38 before insert or update or delete on public.payment_methods
for each row execute function public.guard_admin_write_v38();

grant execute on function public.get_pos_security_state_v38(text) to authenticated;
grant execute on function public.bootstrap_pos_security_v38(text, text, text, text) to authenticated;
grant execute on function public.trust_current_pos_device_v38(text, text, text) to authenticated;
grant execute on function public.list_pos_unlock_staff_v38(text) to authenticated;
grant execute on function public.unlock_pos_staff_v38(text, uuid, text) to authenticated;
grant execute on function public.touch_pos_staff_session_v38() to authenticated;
grant execute on function public.lock_pos_staff_session_v38() to authenticated;
grant execute on function public.admin_list_staff_v38() to authenticated;
grant execute on function public.admin_save_staff_v38(uuid, text, text, jsonb, text, boolean) to authenticated;
grant execute on function public.admin_update_pos_security_v38(integer) to authenticated;
grant execute on function public.admin_list_trusted_devices_v38() to authenticated;
grant execute on function public.admin_set_trusted_device_active_v38(uuid, boolean) to authenticated;

commit;
