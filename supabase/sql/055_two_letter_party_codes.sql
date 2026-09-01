-- Short unified profile codes for both customers and suppliers.
-- Example: Abdul Rahman -> AB-A1B2C3
-- Run after migration 052. It can be run whether or not migration 053 was used.

create or replace function public.make_party_code_v55(
  profile_id uuid,
  profile_name text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  clean_name text;
  name_part text;
  id_part text;
begin
  clean_name := upper(regexp_replace(coalesce(profile_name, ''), '[^[:alpha:]]+', '', 'g'));
  if clean_name = '' then
    name_part := 'PT';
  else
    name_part := rpad(left(clean_name, 2), 2, 'X');
  end if;
  id_part := upper(left(replace(profile_id::text, '-', ''), 6));
  return name_part || '-' || id_part;
end;
$$;

-- Keep the existing trigger function name so installations coming from either
-- migration 052 or 053 begin using the new format for newly saved profiles.
create or replace function public.assign_party_code_v52()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.party_code is null or trim(new.party_code) = '' then
    new.party_code := public.make_party_code_v55(new.id, new.name);
  end if;
  return new;
end;
$$;

-- Convert existing profile codes. Keep this update last so the migration does
-- not attempt another schema operation while customer trigger events are pending.
update public.customers
set party_code = public.make_party_code_v55(id, name);

comment on column public.customers.party_code is
  'Short stable code shared by customer and supplier profiles for thermal labels.';
