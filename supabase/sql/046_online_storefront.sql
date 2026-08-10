-- Public online storefront, separate website content, and email/password admin.
-- Run after 045_ai_memory_pos_tools_voice.sql.

begin;

create table if not exists public.store_settings (
  id boolean primary key default true check (id = true),
  store_name text not null default 'Gatronix Store',
  eyebrow text not null default 'COMPUTERS · COMPONENTS · SERVICE',
  hero_title text not null default 'Build faster. Play harder.',
  hero_subtitle text not null default 'Computers, upgrades and dependable technical support from your local specialists.',
  announcement text not null default 'Islandwide delivery available · Message us for expert advice',
  phone text,
  whatsapp text,
  email text,
  address text,
  opening_hours text,
  accent_color text not null default '#62e7ff',
  secondary_color text not null default '#8b5cf6',
  hero_image_path text,
  facebook_url text,
  instagram_url text,
  is_published boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.store_product_content (
  product_id uuid primary key references public.products(id) on delete cascade,
  custom_name text,
  short_description text,
  description text,
  specifications jsonb not null default '{}'::jsonb,
  image_paths jsonb not null default '[]'::jsonb,
  badge text,
  compare_at_price numeric(12,2),
  is_featured boolean not null default false,
  is_published boolean not null default false,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.store_category_content (
  category_id uuid primary key references public.categories(id) on delete cascade,
  custom_name text,
  description text,
  image_path text,
  is_featured boolean not null default false,
  is_published boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.store_settings (id) values (true)
on conflict (id) do nothing;

-- Make the current active POS catalogue visible for the first setup. New POS
-- products remain unpublished until the store admin reviews them.
insert into public.store_product_content (product_id, is_published)
select p.id, true from public.products p where p.is_active
on conflict (product_id) do nothing;

insert into public.store_category_content (category_id, is_published)
select c.id, true from public.categories c
on conflict (category_id) do nothing;

create or replace function public.is_store_admin_v46()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists(
    select 1
    from public.staff s
    where s.auth_user_id = auth.uid()
      and s.role = 'admin'
      and s.is_active
  );
$$;

alter table public.store_settings enable row level security;
alter table public.store_product_content enable row level security;
alter table public.store_category_content enable row level security;

revoke all on public.store_settings from anon, authenticated;
revoke all on public.store_product_content from anon, authenticated;
revoke all on public.store_category_content from anon, authenticated;

drop policy if exists "store admin settings v46" on public.store_settings;
create policy "store admin settings v46" on public.store_settings
  for all to authenticated
  using (public.is_store_admin_v46())
  with check (public.is_store_admin_v46());

drop policy if exists "store admin products v46" on public.store_product_content;
create policy "store admin products v46" on public.store_product_content
  for all to authenticated
  using (public.is_store_admin_v46())
  with check (public.is_store_admin_v46());

drop policy if exists "store admin categories v46" on public.store_category_content;
create policy "store admin categories v46" on public.store_category_content
  for all to authenticated
  using (public.is_store_admin_v46())
  with check (public.is_store_admin_v46());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'store-product-images',
  'store-product-images',
  true,
  6291456,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read store images v46" on storage.objects;
create policy "public read store images v46"
  on storage.objects for select to public
  using (bucket_id = 'store-product-images');

drop policy if exists "admin upload store images v46" on storage.objects;
create policy "admin upload store images v46"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'store-product-images' and public.is_store_admin_v46());

drop policy if exists "admin update store images v46" on storage.objects;
create policy "admin update store images v46"
  on storage.objects for update to authenticated
  using (bucket_id = 'store-product-images' and public.is_store_admin_v46())
  with check (bucket_id = 'store-product-images' and public.is_store_admin_v46());

drop policy if exists "admin delete store images v46" on storage.objects;
create policy "admin delete store images v46"
  on storage.objects for delete to authenticated
  using (bucket_id = 'store-product-images' and public.is_store_admin_v46());

create or replace function public.get_public_storefront_v46()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'settings', coalesce((
      select to_jsonb(x) from (
        select ss.*, cs.logo_path as company_logo_path,
          coalesce(nullif(ss.phone, ''), cs.phone) as display_phone,
          coalesce(nullif(ss.email, ''), cs.email) as display_email,
          coalesce(nullif(ss.address, ''), cs.address) as display_address
        from public.store_settings ss
        left join public.company_settings cs on cs.id = true
        where ss.id = true
      ) x
    ), '{}'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.web_name) from (
        select c.id as category_id, c.parent_id, c.path,
          coalesce(nullif(scc.custom_name, ''), c.name) as web_name,
          coalesce(scc.description, '') as description,
          scc.image_path, scc.is_featured, scc.sort_order,
          (select count(*)
             from public.products child_product
             join public.store_product_content child_store on child_store.product_id = child_product.id and child_store.is_published
             left join public.categories child_category on child_category.id = child_product.category_id
            where child_product.is_active
              and (child_category.id = c.id or child_category.path like c.path || '/%')) as product_count
        from public.categories c
        join public.store_category_content scc on scc.category_id = c.id and scc.is_published
      ) x
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.is_featured desc, x.sort_order, x.web_name) from (
        select p.id as product_id, p.item_code, p.name as pos_name,
          trim(regexp_replace(coalesce(nullif(spc.custom_name, ''), p.name), '\s*\([^)]*warranty[^)]*\)\s*', ' ', 'gi')) as web_name,
          p.category_id, c.name as category_name, c.path as category_path,
          p.brand_id, b.name as brand_name, p.selling_price,
          spc.compare_at_price, p.warranty_months, p.serial_required, p.track_inventory,
          case when p.track_inventory then greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) else null end as available_qty,
          coalesce(spc.short_description, '') as short_description,
          coalesce(spc.description, p.description, '') as description,
          spc.specifications, spc.image_paths, spc.badge, spc.is_featured, spc.sort_order
        from public.products p
        join public.store_product_content spc on spc.product_id = p.id and spc.is_published
        left join public.categories c on c.id = p.category_id
        left join public.store_category_content scc on scc.category_id = c.id
        left join public.brands b on b.id = p.brand_id
        left join public.stock_balances sb on sb.product_id = p.id
        where p.is_active and (p.category_id is null or coalesce(scc.is_published, true))
      ) x
    ), '[]'::jsonb)
  );
$$;

create or replace function public.store_admin_catalog_v46()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.is_store_admin_v46() then raise exception 'Only the linked POS administrator can manage the online store'; end if;

  select jsonb_build_object(
    'settings', coalesce((select to_jsonb(ss) from public.store_settings ss where ss.id = true), '{}'::jsonb),
    'categories', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.path) from (
        select c.id as category_id, c.name as pos_name, c.path, c.parent_id,
          scc.custom_name, scc.description, scc.image_path,
          coalesce(scc.is_featured, false) as is_featured,
          coalesce(scc.is_published, false) as is_published,
          coalesce(scc.sort_order, 0) as sort_order
        from public.categories c
        left join public.store_category_content scc on scc.category_id = c.id
      ) x
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.pos_name) from (
        select p.id as product_id, p.item_code, p.name as pos_name, p.category_id,
          c.path as category_path, p.selling_price, p.warranty_months, p.track_inventory,
          p.is_active, greatest(coalesce(sb.sellable_qty, 0) - coalesce(sb.reserved_qty, 0), 0) as available_qty,
          spc.custom_name, spc.short_description, spc.description, spc.specifications,
          coalesce(spc.image_paths, '[]'::jsonb) as image_paths, spc.badge, spc.compare_at_price,
          coalesce(spc.is_featured, false) as is_featured,
          coalesce(spc.is_published, false) as is_published,
          coalesce(spc.sort_order, 0) as sort_order
        from public.products p
        left join public.categories c on c.id = p.category_id
        left join public.stock_balances sb on sb.product_id = p.id
        left join public.store_product_content spc on spc.product_id = p.id
      ) x
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.store_admin_save_product_v46(p_product_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_store_admin_v46() then raise exception 'Administrator login required'; end if;
  if not exists(select 1 from public.products p where p.id = p_product_id) then raise exception 'POS product not found'; end if;

  insert into public.store_product_content(
    product_id, custom_name, short_description, description, specifications,
    image_paths, badge, compare_at_price, is_featured, is_published, sort_order, updated_at
  ) values (
    p_product_id,
    nullif(trim(p_payload ->> 'custom_name'), ''),
    nullif(trim(p_payload ->> 'short_description'), ''),
    nullif(trim(p_payload ->> 'description'), ''),
    coalesce(p_payload -> 'specifications', '{}'::jsonb),
    coalesce(p_payload -> 'image_paths', '[]'::jsonb),
    nullif(trim(p_payload ->> 'badge'), ''),
    nullif(p_payload ->> 'compare_at_price', '')::numeric,
    coalesce((p_payload ->> 'is_featured')::boolean, false),
    coalesce((p_payload ->> 'is_published')::boolean, false),
    coalesce((p_payload ->> 'sort_order')::integer, 0),
    now()
  )
  on conflict (product_id) do update set
    custom_name = excluded.custom_name,
    short_description = excluded.short_description,
    description = excluded.description,
    specifications = excluded.specifications,
    image_paths = excluded.image_paths,
    badge = excluded.badge,
    compare_at_price = excluded.compare_at_price,
    is_featured = excluded.is_featured,
    is_published = excluded.is_published,
    sort_order = excluded.sort_order,
    updated_at = now();
end;
$$;

create or replace function public.store_admin_save_category_v46(p_category_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_store_admin_v46() then raise exception 'Administrator login required'; end if;
  insert into public.store_category_content(category_id, custom_name, description, image_path, is_featured, is_published, sort_order, updated_at)
  values (
    p_category_id, nullif(trim(p_payload ->> 'custom_name'), ''), nullif(trim(p_payload ->> 'description'), ''),
    nullif(trim(p_payload ->> 'image_path'), ''), coalesce((p_payload ->> 'is_featured')::boolean, false),
    coalesce((p_payload ->> 'is_published')::boolean, false), coalesce((p_payload ->> 'sort_order')::integer, 0), now()
  )
  on conflict (category_id) do update set custom_name = excluded.custom_name, description = excluded.description,
    image_path = excluded.image_path, is_featured = excluded.is_featured, is_published = excluded.is_published,
    sort_order = excluded.sort_order, updated_at = now();
end;
$$;

create or replace function public.store_admin_save_settings_v46(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_store_admin_v46() then raise exception 'Administrator login required'; end if;
  insert into public.store_settings(
    id, store_name, eyebrow, hero_title, hero_subtitle, announcement, phone, whatsapp, email, address,
    opening_hours, accent_color, secondary_color, hero_image_path, facebook_url, instagram_url, is_published, updated_at
  ) values (
    true, coalesce(nullif(trim(p_payload ->> 'store_name'), ''), 'Gatronix Store'),
    coalesce(nullif(trim(p_payload ->> 'eyebrow'), ''), 'COMPUTERS · COMPONENTS · SERVICE'),
    coalesce(nullif(trim(p_payload ->> 'hero_title'), ''), 'Build faster. Play harder.'),
    coalesce(nullif(trim(p_payload ->> 'hero_subtitle'), ''), 'Computers, upgrades and dependable technical support.'),
    coalesce(p_payload ->> 'announcement', ''), nullif(trim(p_payload ->> 'phone'), ''),
    nullif(trim(p_payload ->> 'whatsapp'), ''), nullif(trim(p_payload ->> 'email'), ''),
    nullif(trim(p_payload ->> 'address'), ''), nullif(trim(p_payload ->> 'opening_hours'), ''),
    coalesce(nullif(trim(p_payload ->> 'accent_color'), ''), '#62e7ff'),
    coalesce(nullif(trim(p_payload ->> 'secondary_color'), ''), '#8b5cf6'),
    nullif(trim(p_payload ->> 'hero_image_path'), ''), nullif(trim(p_payload ->> 'facebook_url'), ''),
    nullif(trim(p_payload ->> 'instagram_url'), ''), coalesce((p_payload ->> 'is_published')::boolean, true), now()
  )
  on conflict (id) do update set store_name = excluded.store_name, eyebrow = excluded.eyebrow,
    hero_title = excluded.hero_title, hero_subtitle = excluded.hero_subtitle, announcement = excluded.announcement,
    phone = excluded.phone, whatsapp = excluded.whatsapp, email = excluded.email, address = excluded.address,
    opening_hours = excluded.opening_hours, accent_color = excluded.accent_color, secondary_color = excluded.secondary_color,
    hero_image_path = excluded.hero_image_path, facebook_url = excluded.facebook_url,
    instagram_url = excluded.instagram_url, is_published = excluded.is_published, updated_at = now();
end;
$$;

create or replace function public.store_admin_publish_all_v46(p_published boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  if not public.is_store_admin_v46() then raise exception 'Administrator login required'; end if;
  insert into public.store_product_content(product_id, is_published, updated_at)
  select p.id, p_published, now() from public.products p where p.is_active
  on conflict (product_id) do update set is_published = excluded.is_published, updated_at = now();
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.get_public_storefront_v46() from public;
grant execute on function public.get_public_storefront_v46() to anon, authenticated;
grant execute on function public.is_store_admin_v46() to authenticated;
grant execute on function public.store_admin_catalog_v46() to authenticated;
grant execute on function public.store_admin_save_product_v46(uuid, jsonb) to authenticated;
grant execute on function public.store_admin_save_category_v46(uuid, jsonb) to authenticated;
grant execute on function public.store_admin_save_settings_v46(jsonb) to authenticated;
grant execute on function public.store_admin_publish_all_v46(boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
