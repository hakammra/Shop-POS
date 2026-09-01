-- Stable printable codes for customer/supplier profiles.
-- Run once in the Supabase SQL Editor before using profile label printing.

alter table public.customers
  add column if not exists party_code text;

create or replace function public.make_party_code_v52(
  profile_id uuid,
  profile_name text,
  profile_is_customer boolean,
  profile_is_supplier boolean
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  prefix text;
  name_part text;
  id_part text;
begin
  prefix := case
    when coalesce(profile_is_customer, true) and coalesce(profile_is_supplier, false) then 'BTH'
    when coalesce(profile_is_supplier, false) then 'SUP'
    else 'CUS'
  end;
  name_part := upper(left(regexp_replace(coalesce(profile_name, ''), '[^[:alnum:]]+', '', 'g'), 5));
  if name_part = '' then name_part := 'PARTY'; end if;
  id_part := upper(left(replace(profile_id::text, '-', ''), 6));
  return prefix || '-' || name_part || '-' || id_part;
end;
$$;

create or replace function public.assign_party_code_v52()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.party_code is null or trim(new.party_code) = '' then
    new.party_code := public.make_party_code_v52(new.id, new.name, new.is_customer, new.is_supplier);
  end if;
  return new;
end;
$$;

drop trigger if exists customers_assign_party_code_v52 on public.customers;
create trigger customers_assign_party_code_v52
before insert or update of name, is_customer, is_supplier on public.customers
for each row execute function public.assign_party_code_v52();

comment on column public.customers.party_code is
  'Stable readable code used on thermal profile/source labels.';

-- Keep the backfill last so existing customer-table triggers can finish after
-- the schema and trigger definitions have been installed.
update public.customers
set party_code = public.make_party_code_v52(id, name, is_customer, is_supplier)
where party_code is null or trim(party_code) = '';
