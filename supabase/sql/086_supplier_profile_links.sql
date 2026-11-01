-- Link supplier records to an exact customer/supplier profile ID. Names are not
-- unique, so they must never be used to choose whose balance/history to show.
begin;

alter table public.suppliers
  add column if not exists party_profile_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and conname = 'suppliers_party_profile_id_fkey'
  ) then
    alter table public.suppliers
      add constraint suppliers_party_profile_id_fkey
      foreign key (party_profile_id) references public.customers(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and conname = 'suppliers_party_profile_id_key'
  ) then
    alter table public.suppliers
      add constraint suppliers_party_profile_id_key unique (party_profile_id);
  end if;
end;
$$;

-- Only link existing rows when their normalized name AND phone match exactly
-- one profile. Ambiguous rows remain unlinked for manual review.
with exact_matches as (
  select s.id as supplier_id, (array_agg(c.id))[1] as profile_id
  from public.suppliers s
  join public.customers c
    on lower(trim(c.name)) = lower(trim(s.name))
   and coalesce(trim(c.phone), '') = coalesce(trim(s.phone), '')
  where s.party_profile_id is null
  group by s.id
  having count(*) = 1
), unique_profiles as (
  select profile_id
  from exact_matches
  group by profile_id
  having count(*) = 1
)
update public.suppliers s
set party_profile_id = m.profile_id
from exact_matches m
join unique_profiles u on u.profile_id = m.profile_id
where s.id = m.supplier_id
  and not exists (
    select 1 from public.suppliers already
    where already.party_profile_id = m.profile_id
  );

create or replace function public.save_party_profile_v61(
  p_profile_id uuid,
  p_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_profile public.customers%rowtype;
  saved_profile public.customers%rowtype;
  supplier_record_id uuid;
  clean_name text := trim(coalesce(p_profile ->> 'name', ''));
  clean_phone text := nullif(trim(coalesce(p_profile ->> 'phone', '')), '');
  clean_address text := nullif(trim(coalesce(p_profile ->> 'address', '')), '');
  next_is_customer boolean;
  next_is_supplier boolean;
begin
  if not public.has_pos_permission_v38('manage_parties') then
    raise exception 'Customer and supplier permission required';
  end if;
  if length(clean_name) < 2 then raise exception 'Profile name is required'; end if;

  select * into existing_profile
  from public.customers
  where id = p_profile_id
  for update;
  if not found then raise exception 'Customer/supplier profile not found'; end if;

  next_is_customer := coalesce(existing_profile.is_customer, true) or coalesce((p_profile ->> 'is_customer')::boolean, false);
  next_is_supplier := coalesce(existing_profile.is_supplier, false) or coalesce((p_profile ->> 'is_supplier')::boolean, false);

  update public.customers
  set name = clean_name,
      phone = clean_phone,
      address = clean_address,
      is_customer = next_is_customer,
      is_supplier = next_is_supplier,
      updated_at = now()
  where id = p_profile_id
  returning * into saved_profile;

  if next_is_supplier then
    select id into supplier_record_id
    from public.suppliers
    where party_profile_id = p_profile_id
    for update;

    if supplier_record_id is null then
      insert into public.suppliers(name, phone, address, party_profile_id)
      values(clean_name, clean_phone, clean_address, p_profile_id);
    else
      update public.suppliers
      set name = clean_name,
          phone = clean_phone,
          address = clean_address,
          updated_at = now()
      where id = supplier_record_id;
    end if;
  end if;

  return to_jsonb(saved_profile);
end;
$$;

create or replace function public.delete_party_profile_v63(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  operator_id uuid;
  profile public.customers%rowtype;
  supplier_record public.suppliers%rowtype;
  history_count bigint := 0;
begin
  operator_id := public.current_pos_staff_id_v38();
  if not exists(
    select 1 from public.staff
    where id = operator_id and role = 'admin' and is_active
  ) then
    raise exception 'An active administrator must delete customer or supplier profiles';
  end if;

  select * into profile from public.customers where id = p_profile_id for update;
  if not found then raise exception 'Customer/supplier profile not found'; end if;
  if abs(coalesce(profile.due_balance, 0) - coalesce(profile.store_credit_balance, 0)) > 0.005 then
    raise exception 'Settle this profile balance before deleting it';
  end if;

  select count(*) into history_count
  from public.documents
  where customer_id = p_profile_id or party_balance_customer_id = p_profile_id;
  if history_count > 0 then
    raise exception 'This profile has % linked document(s) and must be retained for history', history_count;
  end if;

  if to_regclass('public.warranty_records') is not null then
    execute 'select count(*) from public.warranty_records where customer_id = $1'
      into history_count using p_profile_id;
    if history_count > 0 then
      raise exception 'This profile has warranty history and must be retained';
    end if;
  end if;

  select * into supplier_record
  from public.suppliers
  where party_profile_id = p_profile_id
  for update;
  if supplier_record.id is not null then
    select count(*) into history_count from public.documents where supplier_id = supplier_record.id;
    if history_count > 0 then
      raise exception 'This supplier profile has % linked document(s) and must be retained for history', history_count;
    end if;
    delete from public.suppliers where id = supplier_record.id;
  end if;

  delete from public.customers where id = p_profile_id;
  return jsonb_build_object('deleted', true, 'id', p_profile_id, 'name', profile.name);
end;
$$;

revoke all on function public.save_party_profile_v61(uuid, jsonb) from public;
revoke all on function public.delete_party_profile_v63(uuid) from public;
grant execute on function public.save_party_profile_v61(uuid, jsonb) to authenticated;
grant execute on function public.delete_party_profile_v63(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
