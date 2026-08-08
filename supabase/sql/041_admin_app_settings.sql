-- Shared admin-only application settings and optional negative POS inventory.
-- Run once after 040_realtime_business_sync.sql.

begin;

create table if not exists public.app_settings (
  id boolean primary key default true,
  allow_negative_pos_stock boolean not null default false,
  show_pos_stock_badges boolean not null default true,
  confirm_pos_sale boolean not null default false,
  default_payment_method_id uuid references public.payment_methods(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row check (id = true)
);

insert into public.app_settings(id) values(true) on conflict(id) do nothing;

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_settings'
      and policyname = 'authenticated read app settings v41'
  ) then
    create policy "authenticated read app settings v41"
      on public.app_settings for select to authenticated using (true);
  end if;
end
$$;

create or replace function public.get_app_settings_v41()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  settings_row public.app_settings%rowtype;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  select * into settings_row from public.app_settings where id = true;
  return to_jsonb(settings_row);
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
  settings_row public.app_settings%rowtype;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  admin_id := public.current_pos_staff_id_v38();
  if not exists(select 1 from public.staff s where s.id = admin_id and s.role = 'admin' and s.is_active) then
    raise exception 'Only an active admin can change application settings';
  end if;
  if payment_id is not null and not exists(select 1 from public.payment_methods p where p.id = payment_id and p.is_active) then
    raise exception 'The preferred payment method is not active';
  end if;

  insert into public.app_settings(
    id, allow_negative_pos_stock, show_pos_stock_badges,
    confirm_pos_sale, default_payment_method_id, updated_at
  ) values (
    true,
    coalesce((p_settings ->> 'allow_negative_pos_stock')::boolean, false),
    coalesce((p_settings ->> 'show_pos_stock_badges')::boolean, true),
    coalesce((p_settings ->> 'confirm_pos_sale')::boolean, false),
    payment_id,
    now()
  )
  on conflict(id) do update set
    allow_negative_pos_stock = excluded.allow_negative_pos_stock,
    show_pos_stock_badges = excluded.show_pos_stock_badges,
    confirm_pos_sale = excluded.confirm_pos_sale,
    default_payment_method_id = excluded.default_payment_method_id,
    updated_at = now()
  returning * into settings_row;

  insert into public.pos_security_settings(id, auto_lock_minutes, updated_at)
  values(true, lock_minutes, now())
  on conflict(id) do update set auto_lock_minutes = excluded.auto_lock_minutes, updated_at = now();

  return to_jsonb(settings_row);
end;
$$;

-- Reserved stock remains protected everywhere except inside the v41 POS save
-- transaction after the admin has explicitly enabled negative POS inventory.
-- COD reservations and stock adjustments therefore remain strict.
create or replace function public.protect_reserved_stock_v24()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  pos_negative_save boolean := coalesce(current_setting('shop_pos.allow_negative_stock', true), '') = 'on';
begin
  if not pos_negative_save and coalesce(new.sellable_qty, 0) < coalesce(new.reserved_qty, 0) then
    raise exception 'Stock change would consume reserved units for product %', new.product_id;
  end if;
  return new;
end;
$$;

-- The mature invoice function performs accounting, returns, payments and stock
-- movements. When negative stock is enabled, temporarily pad only tracked POS
-- items so its concurrency checks pass, then apply its exact stock delta to the
-- original quantity. Errors roll the entire transaction back automatically.
create or replace function public.save_pos_invoice_v41(
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
  allow_negative boolean := false;
  saved_stock jsonb := '[]'::jsonb;
  stock_item record;
  current_sellable numeric;
  result jsonb;
begin
  select coalesce(s.allow_negative_pos_stock, false)
  into allow_negative
  from public.app_settings s
  where s.id = true;

  if not allow_negative then
    return public.save_pos_invoice_v37(p_header, p_items, p_payments);
  end if;

  perform set_config('shop_pos.allow_negative_stock', 'on', true);

  insert into public.stock_balances(product_id)
  select distinct nullif(x.value ->> 'product_id', '')::uuid
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid
  where coalesce(p.track_inventory, true)
  on conflict(product_id) do nothing;

  for stock_item in
    select
      p.id as product_id,
      greatest(coalesce(sb.sellable_qty, 0), coalesce(sb.reserved_qty, 0) + sum(greatest(coalesce((x.value ->> 'qty')::numeric, 0), 0))) as padded_sellable
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    join public.products p on p.id = nullif(x.value ->> 'product_id', '')::uuid and coalesce(p.track_inventory, true)
    join public.stock_balances sb on sb.product_id = p.id
    group by p.id, sb.sellable_qty, sb.reserved_qty
  loop
    select sb.sellable_qty into current_sellable
    from public.stock_balances sb
    where sb.product_id = stock_item.product_id
    for update;

    saved_stock := saved_stock || jsonb_build_array(jsonb_build_object(
      'product_id', stock_item.product_id,
      'original_sellable', current_sellable,
      'padded_sellable', stock_item.padded_sellable
    ));

    update public.stock_balances
    set sellable_qty = stock_item.padded_sellable, updated_at = now()
    where product_id = stock_item.product_id;
  end loop;

  result := public.save_pos_invoice_v37(p_header, p_items, p_payments);

  for stock_item in
    select * from jsonb_to_recordset(saved_stock) as state(
      product_id uuid,
      original_sellable numeric,
      padded_sellable numeric
    )
  loop
    select sb.sellable_qty into current_sellable
    from public.stock_balances sb
    where sb.product_id = stock_item.product_id
    for update;

    update public.stock_balances
    set sellable_qty = stock_item.original_sellable + (current_sellable - stock_item.padded_sellable),
        updated_at = now()
    where product_id = stock_item.product_id;
  end loop;

  return result;
end;
$$;

revoke all on function public.get_app_settings_v41() from public;
revoke all on function public.admin_save_app_settings_v41(jsonb) from public;
revoke all on function public.save_pos_invoice_v41(jsonb, jsonb, jsonb) from public;
grant execute on function public.get_app_settings_v41() to authenticated;
grant execute on function public.admin_save_app_settings_v41(jsonb) to authenticated;
grant execute on function public.save_pos_invoice_v41(jsonb, jsonb, jsonb) to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'app_settings'
     ) then
    alter publication supabase_realtime add table public.app_settings;
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
