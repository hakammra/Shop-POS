-- Company branding and unified document printing settings.
-- Run after the existing company_settings table migration.

alter table public.company_settings
  add column if not exists email text,
  add column if not exists registration_no text,
  add column if not exists header_subtitle text,
  add column if not exists logo_path text,
  add column if not exists paper_size text not null default 'A5',
  add column if not exists page_margin_mm numeric(5,2) not null default 8,
  add column if not exists show_payment_movements boolean not null default false;

alter table public.company_settings drop constraint if exists company_settings_paper_size_check;
alter table public.company_settings
  add constraint company_settings_paper_size_check check (paper_size in ('A5', 'A4'));

alter table public.company_settings drop constraint if exists company_settings_page_margin_check;
alter table public.company_settings
  add constraint company_settings_page_margin_check check (page_margin_mm between 4 and 20);

update public.company_settings
set paper_size = 'A5',
    page_margin_mm = coalesce(page_margin_mm, 8),
    updated_at = now()
where id = true;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-assets',
  'company-assets',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'authenticated read company assets'
  ) then
    create policy "authenticated read company assets"
      on storage.objects for select to authenticated
      using (bucket_id = 'company-assets');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'authenticated upload company assets'
  ) then
    create policy "authenticated upload company assets"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'company-assets');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'authenticated update company assets'
  ) then
    create policy "authenticated update company assets"
      on storage.objects for update to authenticated
      using (bucket_id = 'company-assets')
      with check (bucket_id = 'company-assets');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'authenticated delete company assets'
  ) then
    create policy "authenticated delete company assets"
      on storage.objects for delete to authenticated
      using (bucket_id = 'company-assets');
  end if;
end $$;

notify pgrst, 'reload schema';
