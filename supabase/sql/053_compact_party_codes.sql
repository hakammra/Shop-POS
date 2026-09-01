-- Compact unified profile codes for both customers and suppliers.
-- Example: Abdul Rahman -> ARN-A1B2C3

create or replace function public.make_party_code_v53(
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
  initials text;
  middle_position integer;
  id_part text;
begin
  clean_name := upper(regexp_replace(coalesce(profile_name, ''), '[^[:alnum:]]+', '', 'g'));
  if clean_name = '' then clean_name := 'PTY'; end if;
  middle_position := greatest(ceil(length(clean_name)::numeric / 2)::integer, 1);
  initials := substr(clean_name, 1, 1)
    || substr(clean_name, middle_position, 1)
    || substr(clean_name, length(clean_name), 1);
  id_part := upper(left(replace(profile_id::text, '-', ''), 6));
  return initials || '-' || id_part;
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
    new.party_code := public.make_party_code_v53(new.id, new.name);
  end if;
  return new;
end;
$$;

-- Convert all codes created by migration 052 to the new compact format.
-- Keep this update last so no later schema operation is blocked by pending
-- customer-table trigger events in the SQL Editor transaction.
update public.customers
set party_code = public.make_party_code_v53(id, name);

comment on column public.customers.party_code is
  'Compact stable code shared by customer and supplier profiles for thermal labels.';
