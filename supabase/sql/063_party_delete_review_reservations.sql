-- v63: Safe customer/supplier deletion and stock reservations for review sales.
-- Run once after 062_start_fresh_and_aronium_imports.sql.

begin;

alter table public.documents
  add column if not exists review_stock_reserved boolean not null default false;

create or replace function public.release_review_sale_reservation_v63(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'Review sale not found'; end if;
  if doc.document_type <> 'unconfirmed_sale' then raise exception 'Document is not a review sale'; end if;
  if not coalesce(doc.review_stock_reserved, false) then return; end if;

  for item in
    select di.*
    from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id
      and coalesce(p.track_inventory, true)
      and coalesce(di.qty, 0) > 0
  loop
    insert into public.stock_balances(product_id) values(item.product_id)
    on conflict(product_id) do nothing;
    update public.stock_balances
    set reserved_qty = greatest(coalesce(reserved_qty, 0) - item.qty, 0),
        updated_at = now()
    where product_id = item.product_id;
    insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes)
    values(item.product_id, p_document_id, 'release_reserve', -item.qty, item.unit_cost, 'Review sale reservation released');
  end loop;

  update public.documents
  set review_stock_reserved = false, updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.apply_review_sale_reservation_v63(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  item record;
  available numeric(12,3);
begin
  select * into doc from public.documents where id = p_document_id for update;
  if not found then raise exception 'Review sale not found'; end if;
  if doc.document_type <> 'unconfirmed_sale' or doc.status <> 'unconfirmed' then
    raise exception 'Only an unconfirmed review sale can reserve stock';
  end if;
  if coalesce(doc.review_stock_reserved, false) then return; end if;

  for item in
    select di.*
    from public.document_items di
    join public.products p on p.id = di.product_id
    where di.document_id = p_document_id
      and coalesce(p.track_inventory, true)
  loop
    if coalesce(item.qty, 0) <= 0 then raise exception 'Review sale quantities must be greater than zero'; end if;
    insert into public.stock_balances(product_id) values(item.product_id)
    on conflict(product_id) do nothing;
    select coalesce(sellable_qty, 0) - coalesce(reserved_qty, 0)
    into available
    from public.stock_balances
    where product_id = item.product_id
    for update;
    if available < item.qty then
      raise exception 'Not enough available stock for %. Available %, requested %', coalesce(item.item_code, item.description), available, item.qty;
    end if;
    update public.stock_balances
    set reserved_qty = coalesce(reserved_qty, 0) + item.qty,
        updated_at = now()
    where product_id = item.product_id;
    insert into public.stock_movements(product_id, document_id, movement_type, qty, unit_cost, notes)
    values(item.product_id, p_document_id, 'reserve', item.qty, item.unit_cost, 'Reserved for review sale');
  end loop;

  update public.documents
  set review_stock_reserved = true, updated_at = now()
  where id = p_document_id;
end;
$$;

create or replace function public.save_unconfirmed_sale_v63(
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
  source_id uuid := nullif(p_header ->> 'document_id', '')::uuid;
  result jsonb;
begin
  -- Editing must first release the old quantities. A failure later in this
  -- transaction restores the original reservation automatically.
  if source_id is not null then
    perform public.release_review_sale_reservation_v63(source_id);
  end if;
  result := public.save_unconfirmed_sale_v57(p_header, p_items, p_payments);
  perform public.apply_review_sale_reservation_v63((result ->> 'id')::uuid);
  return result || jsonb_build_object('stock_reserved', true);
end;
$$;

create or replace function public.confirm_unconfirmed_sale_v63(
  p_source_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  -- Release immediately before the normal invoice posts its stock deduction.
  -- PostgreSQL rolls the release back if invoice posting fails.
  perform public.release_review_sale_reservation_v63(p_source_document_id);
  result := public.confirm_unconfirmed_sale_v57(p_source_document_id, p_header, p_items, p_payments);
  return result || jsonb_build_object('stock_reservation_released', true);
end;
$$;

create or replace function public.delete_unconfirmed_sale_v63(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.release_review_sale_reservation_v63(p_document_id);
  result := public.delete_unconfirmed_sale_v57(p_document_id);
  return result || jsonb_build_object('stock_reservation_released', true);
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

  if coalesce(profile.is_supplier, false) then
    select s.* into supplier_record
    from public.suppliers s
    where lower(trim(s.name)) = lower(trim(profile.name))
      and coalesce(trim(s.phone), '') = coalesce(trim(profile.phone), '')
    order by s.created_at
    limit 1
    for update;

    if supplier_record.id is not null then
      select count(*) into history_count from public.documents where supplier_id = supplier_record.id;
      if history_count > 0 then
        raise exception 'This supplier profile has % linked document(s) and must be retained for history', history_count;
      end if;
      delete from public.suppliers where id = supplier_record.id;
    end if;
  end if;

  delete from public.customers where id = p_profile_id;
  return jsonb_build_object('deleted', true, 'id', p_profile_id, 'name', profile.name);
end;
$$;

revoke all on function public.release_review_sale_reservation_v63(uuid) from public;
revoke all on function public.apply_review_sale_reservation_v63(uuid) from public;
revoke all on function public.save_unconfirmed_sale_v63(jsonb, jsonb, jsonb) from public;
revoke all on function public.confirm_unconfirmed_sale_v63(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.delete_unconfirmed_sale_v63(uuid) from public;
revoke all on function public.delete_party_profile_v63(uuid) from public;
grant execute on function public.save_unconfirmed_sale_v63(jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.confirm_unconfirmed_sale_v63(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.delete_unconfirmed_sale_v63(uuid) to authenticated;
grant execute on function public.delete_party_profile_v63(uuid) to authenticated;

-- Bring already-open review sales into the same reservation workflow.
do $$
declare existing_review record;
begin
  for existing_review in
    select id from public.documents
    where document_type = 'unconfirmed_sale' and status = 'unconfirmed'
  loop
    begin
      perform public.apply_review_sale_reservation_v63(existing_review.id);
    exception when others then
      -- Do not prevent the migration when an older review document now exceeds
      -- available stock. Editing that document later will require a valid
      -- reservation before it can be saved again.
      raise warning 'Could not reserve stock for existing review sale %: %', existing_review.id, sqlerrm;
    end;
  end loop;
end;
$$;

insert into public.assistant_pos_guides(topic, area, keywords, content)
values(
  'Save and confirm an internal-review sale',
  'POS',
  array['unconfirmed','review sale','draft sale','dummy sale','confirm sale','reserved stock'],
  '1. Build the bill in POS normally. 2. Choose the diamond review icon beside Void Bill. 3. Save the document. Tracked items are reserved immediately so they cannot be sold again, but payment, customer balances, accounting, and reports are not posted yet. The customer PDF still looks like a normal Sales Invoice. 4. Staff can find it in Documents under Unconfirmed Sale and edit it or delete it to release the reservation. 5. An administrator selects it in Documents, chooses Confirm Sale, reviews it in POS, and saves. Confirmation releases the reservation and posts the normal sale stock deduction and payment. The review icon resets for the next bill.'
)
on conflict ((lower(topic))) do update set
  area = excluded.area,
  keywords = excluded.keywords,
  content = excluded.content,
  is_active = true,
  updated_at = now();

insert into public.assistant_pos_guides(topic, area, keywords, content)
values(
  'Delete an unused customer or supplier profile',
  'Customers & Suppliers',
  array['delete customer','delete supplier','remove profile','unused customer'],
  '1. Open Customers & Suppliers and select the profile. 2. An administrator can choose Delete Profile. 3. Confirm the warning. For audit safety, deletion is allowed only when the balance is settled and the profile has no linked sales, purchases, payments, jobs, or warranty history. Used profiles must be retained; correct their details with Edit Profile instead.'
)
on conflict ((lower(topic))) do update set
  area = excluded.area,
  keywords = excluded.keywords,
  content = excluded.content,
  is_active = true,
  updated_at = now();

notify pgrst, 'reload schema';
commit;
