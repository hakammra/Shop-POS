-- Fix ambiguous output-column references in the migration 038 admin list RPCs.
-- Run this once after 038_trusted_devices_staff_pins_permissions.sql.

create or replace function public.admin_list_staff_v38()
returns table(id uuid, full_name text, role text, is_active boolean, permissions jsonb, has_pin boolean, auth_email text, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.has_pos_permission_v38('__admin__') then
    if not exists(
      select 1
      from public.staff admin_staff
      where admin_staff.id = public.current_pos_staff_id_v38()
        and admin_staff.role = 'admin'
        and admin_staff.is_active
    ) then
      raise exception 'Admin PIN required';
    end if;
  end if;

  return query
  select
    s.id,
    s.full_name,
    s.role,
    s.is_active,
    coalesce(s.permissions, '{}'::jsonb),
    s.pin_hash is not null,
    u.email::text,
    s.created_at,
    s.updated_at
  from public.staff s
  left join auth.users u on u.id = s.auth_user_id
  order by case when s.role = 'admin' then 0 else 1 end, s.full_name;
end;
$$;

create or replace function public.admin_list_trusted_devices_v38()
returns table(id uuid, device_name text, is_active boolean, last_seen_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_id uuid;
begin
  admin_id := public.current_pos_staff_id_v38();
  if not exists(
    select 1
    from public.staff admin_staff
    where admin_staff.id = admin_id
      and admin_staff.role = 'admin'
      and admin_staff.is_active
  ) then
    raise exception 'Admin PIN required';
  end if;

  return query
  select d.id, d.device_name, d.is_active, d.last_seen_at, d.created_at
  from public.trusted_pos_devices d
  order by d.last_seen_at desc;
end;
$$;

grant execute on function public.admin_list_staff_v38() to authenticated;
grant execute on function public.admin_list_trusted_devices_v38() to authenticated;
