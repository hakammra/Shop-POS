-- Safe customer/supplier profile editing and role promotion.
-- Existing roles are retained so document and payment history remains valid.

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

  -- A used role is never silently removed. The other role can be added later.
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
    where lower(trim(name)) = lower(trim(existing_profile.name))
      and (
        coalesce(trim(existing_profile.phone), '') = ''
        or coalesce(trim(phone), '') = ''
        or trim(phone) = trim(existing_profile.phone)
      )
    order by case when coalesce(trim(phone), '') = coalesce(trim(existing_profile.phone), '') then 0 else 1 end, created_at
    limit 1
    for update;

    if supplier_record_id is null then
      insert into public.suppliers(name, phone, address)
      values(clean_name, clean_phone, clean_address);
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

revoke all on function public.save_party_profile_v61(uuid, jsonb) from public;
grant execute on function public.save_party_profile_v61(uuid, jsonb) to authenticated;

insert into public.assistant_pos_guides(topic, area, keywords, content)
values(
  'Edit a customer or supplier profile and add another role',
  'Customers & Suppliers',
  array['edit profile','supplier becomes customer','customer becomes supplier','customer supplier both','change phone','change address'],
  '1. Open Customers & Suppliers and select the existing profile. 2. Choose Edit Profile. 3. Correct the name, phone, or address when needed. 4. Under Profile roles, tick Customer when an existing supplier also becomes a customer, or tick Supplier when an existing customer also becomes a supplier. 5. Choose Save Profile. Use the same profile instead of creating a duplicate. Existing roles remain enabled so old documents and payment history stay connected.'
)
on conflict ((lower(topic))) do update set
  area = excluded.area,
  keywords = excluded.keywords,
  content = excluded.content,
  is_active = true,
  updated_at = now();
