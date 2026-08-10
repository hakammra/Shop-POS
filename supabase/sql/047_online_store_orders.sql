-- Website order intake connected to the POS Online Orders page.
-- These are requests only: they do not create sales, cashflow, or stock movements.
-- Run after 046_online_storefront.sql.

begin;

create sequence if not exists public.online_store_order_number_v47_seq start 1;

create table if not exists public.online_store_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  status text not null default 'new' check (status in ('new', 'contacted', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')),
  customer_name text not null,
  phone text not null,
  email text,
  delivery_address text,
  city text,
  fulfillment_method text not null default 'delivery' check (fulfillment_method in ('delivery', 'pickup')),
  payment_preference text not null default 'cod' check (payment_preference in ('cod', 'bank', 'pickup', 'card')),
  customer_notes text,
  subtotal numeric(12,2) not null default 0,
  delivery_charge numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  reviewed_by_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.online_store_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.online_store_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  item_code text,
  product_name text not null,
  quantity integer not null check (quantity > 0 and quantity <= 99),
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists online_store_orders_status_created_v47_idx
  on public.online_store_orders(status, created_at desc);
create index if not exists online_store_order_items_order_v47_idx
  on public.online_store_order_items(order_id);

alter table public.online_store_orders enable row level security;
alter table public.online_store_order_items enable row level security;
revoke all on public.online_store_orders from anon, authenticated;
revoke all on public.online_store_order_items from anon, authenticated;

create or replace function public.submit_online_store_order_v47(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_order public.online_store_orders;
  requested_item jsonb;
  product_row record;
  requested_qty integer;
  calculated_subtotal numeric(12,2) := 0;
  clean_name text := trim(coalesce(p_order ->> 'customer_name', ''));
  clean_phone text := trim(coalesce(p_order ->> 'phone', ''));
  fulfillment text := coalesce(nullif(p_order ->> 'fulfillment_method', ''), 'delivery');
  payment text := coalesce(nullif(p_order ->> 'payment_preference', ''), 'cod');
  item_count integer := jsonb_array_length(coalesce(p_order -> 'items', '[]'::jsonb));
begin
  if length(clean_name) < 2 or length(clean_name) > 120 then raise exception 'Enter a valid customer name'; end if;
  if length(clean_phone) < 7 or length(clean_phone) > 30 then raise exception 'Enter a valid phone number'; end if;
  if fulfillment not in ('delivery', 'pickup') then raise exception 'Invalid delivery method'; end if;
  if payment not in ('cod', 'bank', 'pickup', 'card') then raise exception 'Invalid payment preference'; end if;
  if fulfillment = 'delivery' and length(trim(coalesce(p_order ->> 'delivery_address', ''))) < 5 then
    raise exception 'Enter the delivery address';
  end if;
  if item_count < 1 or item_count > 50 then raise exception 'The order must contain between 1 and 50 products'; end if;
  if exists(select 1 from public.online_store_orders o where o.phone = clean_phone and o.created_at > now() - interval '2 minutes') then
    raise exception 'Please wait before submitting another order with this phone number';
  end if;
  if (select count(*) from public.online_store_orders o where o.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'The store is receiving many orders. Please try again in a minute';
  end if;

  insert into public.online_store_orders(
    order_no, customer_name, phone, email, delivery_address, city,
    fulfillment_method, payment_preference, customer_notes
  ) values (
    'WEB-' || to_char(current_date, 'YYMMDD') || '-' || lpad(nextval('public.online_store_order_number_v47_seq')::text, 5, '0'),
    clean_name,
    clean_phone,
    nullif(left(trim(coalesce(p_order ->> 'email', '')), 200), ''),
    nullif(left(trim(coalesce(p_order ->> 'delivery_address', '')), 500), ''),
    nullif(left(trim(coalesce(p_order ->> 'city', '')), 120), ''),
    fulfillment,
    payment,
    nullif(left(trim(coalesce(p_order ->> 'customer_notes', '')), 1000), '')
  ) returning * into new_order;

  for requested_item in select value from jsonb_array_elements(p_order -> 'items') loop
    requested_qty := coalesce((requested_item ->> 'quantity')::integer, 0);
    if requested_qty < 1 or requested_qty > 99 then raise exception 'Invalid product quantity'; end if;

    select p.id, p.item_code,
      trim(regexp_replace(coalesce(nullif(spc.custom_name, ''), p.name), '\s*\([^)]*warranty[^)]*\)\s*', ' ', 'gi')) as web_name,
      p.selling_price, p.track_inventory,
      greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) as available_qty
      into product_row
      from public.products p
      join public.store_product_content spc on spc.product_id = p.id and spc.is_published
      left join public.stock_balances sb on sb.product_id = p.id
     where p.id = (requested_item ->> 'product_id')::uuid
       and p.is_active;

    if product_row.id is null then raise exception 'A selected product is no longer available online'; end if;
    if product_row.track_inventory and requested_qty > product_row.available_qty then
      raise exception 'Only % of % is currently available', product_row.available_qty, product_row.web_name;
    end if;

    insert into public.online_store_order_items(order_id, product_id, item_code, product_name, quantity, unit_price, line_total)
    values (new_order.id, product_row.id, product_row.item_code, product_row.web_name, requested_qty,
      product_row.selling_price, round(product_row.selling_price * requested_qty, 2));
    calculated_subtotal := calculated_subtotal + round(product_row.selling_price * requested_qty, 2);
  end loop;

  update public.online_store_orders
     set subtotal = calculated_subtotal, total_amount = calculated_subtotal, updated_at = now()
   where id = new_order.id;

  return jsonb_build_object(
    'id', new_order.id,
    'order_no', new_order.order_no,
    'status', 'new',
    'total_amount', calculated_subtotal
  );
exception when others then
  raise;
end;
$$;

create or replace function public.list_online_store_orders_v47(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_pos_permission_v38('manage_online_orders') then
    raise exception 'Online Orders permission required';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
    from (
      select o.*,
        coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.online_store_order_items i where i.order_id = o.id), '[]'::jsonb) as items
      from public.online_store_orders o
      where p_status is null or p_status = '' or o.status = p_status
      limit 500
    ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.update_online_store_order_status_v47(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare updated_order public.online_store_orders;
begin
  if not public.has_pos_permission_v38('manage_online_orders') then
    raise exception 'Online Orders permission required';
  end if;
  if p_status not in ('new', 'contacted', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled') then
    raise exception 'Invalid online order status';
  end if;
  update public.online_store_orders
     set status = p_status, reviewed_by_staff_id = public.current_pos_staff_id_v38(), updated_at = now()
   where id = p_order_id
   returning * into updated_order;
  if updated_order.id is null then raise exception 'Online order not found'; end if;
  return to_jsonb(updated_order);
end;
$$;

revoke all on function public.submit_online_store_order_v47(jsonb) from public;
revoke all on function public.list_online_store_orders_v47(text) from public;
revoke all on function public.update_online_store_order_status_v47(uuid, text) from public;
grant execute on function public.submit_online_store_order_v47(jsonb) to anon, authenticated;
grant execute on function public.list_online_store_orders_v47(text) to authenticated;
grant execute on function public.update_online_store_order_status_v47(uuid, text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.online_store_orders;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.online_store_order_items;
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
commit;
