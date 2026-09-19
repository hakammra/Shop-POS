-- v76: Just-in-time Wholesale -> Retail catalog and checkout bridge.
-- Run once after 075_edit_party_payments_documents_ui.sql.

begin;

create extension if not exists pgcrypto;

create table if not exists public.retail_wholesale_product_links (
  id uuid primary key default gen_random_uuid(),
  wholesale_product_id uuid not null unique,
  retail_product_id uuid not null unique references public.products(id) on delete cascade,
  wholesale_item_code text,
  wholesale_name text,
  wholesale_barcode text,
  wholesale_model text,
  wholesale_description text,
  wholesale_category_name text,
  wholesale_unit_name text,
  wholesale_updated_at timestamptz,
  last_transfer_price numeric(12,2) not null default 0,
  last_wholesale_available_qty numeric(12,3) not null default 0,
  last_synced_at timestamptz not null default now(),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists retail_wholesale_links_enabled_idx
  on public.retail_wholesale_product_links(is_enabled, last_synced_at desc);

create table if not exists public.retail_wholesale_transfers (
  id uuid primary key,
  idempotency_key text not null unique,
  request_fingerprint text not null,
  status text not null default 'pending'
    check (status in ('pending', 'wholesale_posted', 'retail_posted', 'failed')),
  next_step text not null default 'wholesale_post'
    check (next_step in ('wholesale_post', 'retail_post', 'complete')),
  retail_sale_reference text not null unique,
  request_payload jsonb not null,
  wholesale_request jsonb not null,
  wholesale_response jsonb,
  wholesale_document_id uuid,
  wholesale_document_no text,
  wholesale_customer_id uuid,
  wholesale_transfer_total numeric(12,2),
  retail_purchase_document_id uuid references public.documents(id) on delete set null,
  retail_invoice_document_id uuid references public.documents(id) on delete set null,
  requested_by_staff_id uuid references public.staff(id) on delete set null,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  wholesale_posted_at timestamptz,
  retail_posted_at timestamptz
);

create index if not exists retail_wholesale_transfers_status_idx
  on public.retail_wholesale_transfers(status, updated_at desc);

alter table public.retail_wholesale_product_links enable row level security;
alter table public.retail_wholesale_transfers enable row level security;

revoke all on public.retail_wholesale_product_links from anon, authenticated;
grant select on public.retail_wholesale_product_links to authenticated;
grant all on public.retail_wholesale_product_links to service_role;
drop policy if exists "authenticated can read wholesale product links" on public.retail_wholesale_product_links;
create policy "authenticated can read wholesale product links"
  on public.retail_wholesale_product_links for select to authenticated using (true);

revoke all on public.retail_wholesale_transfers from anon, authenticated;
grant all on public.retail_wholesale_transfers to service_role;

-- POS-compatible view. For a linked wholesale product, the displayed availability
-- is Wholesale availability; local Retail stock remains the source for all others.
create or replace view public.pos_product_catalog_v76
with (security_invoker = true)
as
select
  p.id as product_id, p.item_code, p.name, p.category_id, p.barcode, p.selling_price, p.avg_cost,
  case when coalesce(p.avg_cost,0) <= 0 then 0 else round(((coalesce(p.selling_price,0)-coalesce(p.avg_cost,0))/nullif(p.avg_cost,0))*100,2) end as markup_percent,
  p.min_stock_level, p.online_visible, p.is_active, p.status,
  c.name as category_name, c.path as category_path, c.parent_id as category_parent_id, b.name as brand_name,
  coalesce(s.sellable_qty,0) as sellable_qty, coalesce(s.sellable_qty,0) as quantity,
  coalesce(s.reserved_qty,0) as reserved_qty, coalesce(s.damaged_qty,0) as damaged_qty,
  coalesce(s.checking_qty,0) as checking_qty,
  case when l.id is not null and l.is_enabled
    then greatest(coalesce(l.last_wholesale_available_qty,0),0)
    else coalesce(s.sellable_qty,0)-coalesce(s.reserved_qty,0)
  end as available_qty,
  coalesce(s.sellable_qty,0)-coalesce(s.reserved_qty,0) as retail_available_qty,
  coalesce(s.in_transit_qty,0) as in_transit_qty,
  coalesce(s.sellable_qty,0)*coalesce(p.avg_cost,0) as total_cost_value,
  coalesce(s.sellable_qty,0)*coalesce(p.selling_price,0) as total_sale_value,
  coalesce(s.in_transit_qty,0)*coalesce(p.avg_cost,0) as in_transit_value,
  (coalesce(p.track_inventory,true) and coalesce(s.sellable_qty,0) <= coalesce(p.min_stock_level,1)) as is_low_stock,
  p.warranty_months, p.serial_required, p.track_inventory,
  p.inventory_ownership, p.consignment_owner_id, p.consignment_unit_payout,
  owner.name as consignment_owner_name,
  l.wholesale_product_id,
  l.last_wholesale_available_qty as wholesale_available_qty,
  l.last_transfer_price,
  (l.id is not null) as is_wholesale_linked,
  coalesce(l.is_enabled,false) as wholesale_link_enabled,
  l.last_synced_at as wholesale_last_synced_at
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id
left join public.customers owner on owner.id = p.consignment_owner_id
left join public.retail_wholesale_product_links l on l.retail_product_id = p.id;

grant select on public.pos_product_catalog_v76 to authenticated;

-- Only the Retail Edge Function service-role client may synchronize the catalog.
-- Existing Retail selling_price and avg_cost are intentionally never updated here.
create or replace function public.sync_retail_wholesale_catalog_v76(p_catalog jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  product_json jsonb;
  wholesale_id uuid;
  retail_id uuid;
  category_uuid uuid;
  clean_code text;
  clean_name text;
  clean_category text;
  inserted_count integer := 0;
  updated_count integer := 0;
  catalog_ids uuid[] := array[]::uuid[];
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Catalog synchronization is server-only';
  end if;
  if jsonb_typeof(coalesce(p_catalog,'[]'::jsonb)) <> 'array' then
    raise exception 'Wholesale catalog must be a JSON array';
  end if;

  for product_json in select value from jsonb_array_elements(coalesce(p_catalog,'[]'::jsonb)) loop
    wholesale_id := nullif(product_json->>'wholesale_product_id','')::uuid;
    clean_code := trim(coalesce(product_json->>'item_code',''));
    clean_name := trim(coalesce(product_json->>'product_name',''));
    clean_category := trim(coalesce(product_json->>'category_name','Uncategorized'));
    if wholesale_id is null or clean_code = '' or clean_name = '' then
      raise exception 'Wholesale product identity, item code and name are required';
    end if;
    catalog_ids := array_append(catalog_ids, wholesale_id);
    clean_category := replace(replace(clean_category,'/',' - '),'\\',' - ');
    category_uuid := public.get_or_create_category_path('Wholesale Catalog/' || coalesce(nullif(clean_category,''),'Uncategorized'));

    select l.retail_product_id into retail_id
    from public.retail_wholesale_product_links l
    where l.wholesale_product_id = wholesale_id;

    if retail_id is null then
      select p.id into retail_id
      from public.products p
      where lower(trim(p.item_code)) = lower(clean_code)
        and coalesce(p.inventory_ownership,'owned')='owned'
        and not exists(select 1 from public.retail_wholesale_product_links used where used.retail_product_id=p.id)
      limit 1;
    end if;

    if retail_id is null then
      if exists(select 1 from public.products where lower(trim(item_code))=lower(clean_code)) then
        raise exception 'Retail product code % is already assigned to an incompatible or differently linked product',clean_code;
      end if;
      insert into public.products(
        item_code,name,category_id,barcode,model_number,description,selling_price,avg_cost,
        min_stock_level,warranty_months,serial_required,track_inventory,online_visible,is_active,status
      ) values (
        clean_code,clean_name,category_uuid,nullif(product_json->>'barcode',''),nullif(product_json->>'model',''),
        nullif(product_json->>'description',''),greatest(coalesce((product_json->>'transfer_unit_price')::numeric,0),0),0,
        0,0,false,true,false,true,'active'
      ) returning id into retail_id;
      insert into public.stock_balances(product_id) values(retail_id) on conflict(product_id) do nothing;
      inserted_count := inserted_count + 1;
    else
      -- Do not overwrite a code if another Retail product owns it. UUID remains the identity.
      update public.products p set
        item_code = case when not exists(
          select 1 from public.products other where other.id<>p.id and lower(trim(other.item_code))=lower(clean_code)
        ) then clean_code else p.item_code end,
        name = clean_name,
        category_id = category_uuid,
        barcode = nullif(product_json->>'barcode',''),
        model_number = nullif(product_json->>'model',''),
        description = nullif(product_json->>'description',''),
        track_inventory = true,
        is_active = true,
        status = 'active',
        updated_at = now()
      where p.id = retail_id;
      insert into public.stock_balances(product_id) values(retail_id) on conflict(product_id) do nothing;
      updated_count := updated_count + 1;
    end if;

    insert into public.retail_wholesale_product_links(
      wholesale_product_id,retail_product_id,wholesale_item_code,wholesale_name,wholesale_barcode,
      wholesale_model,wholesale_description,wholesale_category_name,wholesale_unit_name,wholesale_updated_at,
      last_transfer_price,last_wholesale_available_qty,last_synced_at,is_enabled,updated_at
    ) values (
      wholesale_id,retail_id,clean_code,clean_name,nullif(product_json->>'barcode',''),
      nullif(product_json->>'model',''),nullif(product_json->>'description',''),clean_category,
      nullif(product_json->>'unit_name',''),nullif(product_json->>'updated_at','')::timestamptz,
      greatest(coalesce((product_json->>'transfer_unit_price')::numeric,0),0),
      greatest(coalesce((product_json->>'available_qty')::numeric,0),0),now(),true,now()
    )
    on conflict(wholesale_product_id) do update set
      retail_product_id=excluded.retail_product_id,wholesale_item_code=excluded.wholesale_item_code,
      wholesale_name=excluded.wholesale_name,wholesale_barcode=excluded.wholesale_barcode,
      wholesale_model=excluded.wholesale_model,wholesale_description=excluded.wholesale_description,
      wholesale_category_name=excluded.wholesale_category_name,wholesale_unit_name=excluded.wholesale_unit_name,
      wholesale_updated_at=excluded.wholesale_updated_at,last_transfer_price=excluded.last_transfer_price,
      last_wholesale_available_qty=excluded.last_wholesale_available_qty,last_synced_at=now(),
      is_enabled=true,updated_at=now();
  end loop;

  update public.retail_wholesale_product_links
  set is_enabled=false,last_wholesale_available_qty=0,last_synced_at=now(),updated_at=now()
  where is_enabled and not (wholesale_product_id = any(catalog_ids));

  return jsonb_build_object('products',cardinality(catalog_ids),'created',inserted_count,'updated',updated_count,'synced_at',now());
end;
$$;

-- Bridge-created purchases are an internal part of POS checkout. Attribute them
-- to the active POS operator, but require POS-sale permission rather than giving
-- every cashier general inventory-document permission.
create or replace function public.audit_document_operator_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare operator_id uuid; document_operator_id uuid; needed_permission text; bridge_checkout boolean;
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if current_setting('shop_pos.restore_mode',true)='on' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  operator_id := public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if tg_op = 'DELETE' then
    if exists(select 1 from public.retail_wholesale_transfers t
      where t.status='retail_posted' and (t.retail_invoice_document_id=old.id or t.retail_purchase_document_id=old.id)) then
      raise exception 'This document belongs to a completed Wholesale transfer and cannot be deleted independently';
    end if;
    if old.document_type = 'invoice' then
      if current_setting('shop_pos.sales_edit_cleanup_id', true) = old.id::text
         and public.has_pos_permission_v38('edit_sales_documents') then return old; end if;
      if not public.has_pos_permission_v38('delete_sales_documents') then raise exception 'Delete finalized sales documents permission required'; end if;
      return old;
    end if;
    if not public.has_pos_permission_v38('delete_documents') then raise exception 'You do not have permission to delete documents'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and exists(
    select 1 from public.retail_wholesale_transfers t
    where t.status='retail_posted' and (t.retail_invoice_document_id=old.id or t.retail_purchase_document_id=old.id)
  ) and nullif(current_setting('shop_pos.retail_wholesale_transfer_id',true),'') is null then
    raise exception 'This document belongs to a completed Wholesale transfer and cannot be edited independently';
  end if;
  bridge_checkout := new.document_type='purchase' and nullif(current_setting('shop_pos.retail_wholesale_transfer_id',true),'') is not null;
  document_operator_id:=operator_id;
  if nullif(current_setting('shop_pos.retail_wholesale_operator_id',true),'') is not null then
    select id into document_operator_id from public.staff
    where id=current_setting('shop_pos.retail_wholesale_operator_id',true)::uuid limit 1;
    document_operator_id:=coalesce(document_operator_id,operator_id);
  end if;
  needed_permission := case
    when bridge_checkout then 'pos_sales'
    when new.document_type in ('invoice','unconfirmed_sale') then 'pos_sales'
    when new.document_type in ('reservation','quotation') then 'create_quotes'
    when new.document_type='cod_order' then 'manage_cod_orders'
    when new.document_type='online_order' then 'manage_online_orders'
    when new.document_type='job' then 'manage_jobs'
    when new.document_type in ('purchase','stock_in_transit','stock_receiving','stock_adjustment','stock_condition_transfer','consignment_intake','consignment_return','trade_in') then 'manage_inventory_documents'
    when new.document_type in ('customer_payment','supplier_payment') then 'manage_parties'
    when new.document_type in ('expense','other_income','account_transfer') then 'manage_cashflow'
    when new.document_type='refund' then 'process_returns'
    else 'view_documents' end;
  if not public.has_pos_permission_v38(needed_permission) then raise exception 'The active user does not have permission for this document action'; end if;
  if tg_op='INSERT' then
    new.created_by_staff_id:=document_operator_id;
    if new.document_type='cod_order' then new.order_taken_by:=document_operator_id; end if;
  else
    new.created_by_staff_id:=old.created_by_staff_id;
    if new.document_type='cod_order' then new.order_taken_by:=coalesce(old.order_taken_by,old.created_by_staff_id,operator_id); end if;
  end if;
  new.updated_by_staff_id:=document_operator_id;
  return new;
end;
$$;

create or replace function public.guard_product_write_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt()->>'role','')='service_role'
     or nullif(current_setting('request.jwt.claims',true),'') is null then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if nullif(current_setting('shop_pos.retail_wholesale_transfer_id',true),'') is not null
     and public.has_pos_permission_v38('pos_sales') then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if not public.has_pos_permission_v38('manage_products') then raise exception 'You do not have permission to change products'; end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create or replace function public.authorize_retail_wholesale_catalog_v76()
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not (exists(select 1 from public.staff where id=public.current_pos_staff_id_v38() and role='admin' and is_active)
      or public.has_pos_permission_v38('manage_products')) then
    raise exception 'Product-management permission required';
  end if;
  return true;
end;
$$;

create or replace function public.authorize_retail_wholesale_admin_v76()
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.staff where id=public.current_pos_staff_id_v38() and role='admin' and is_active) then
    raise exception 'Administrator permission required';
  end if;
  return true;
end;
$$;

create or replace function public.prepare_retail_wholesale_transfer_v76(p_transfer_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  existing public.retail_wholesale_transfers%rowtype;
  fingerprint text;
  sale_reference text;
  normalized_payload jsonb;
  request_items jsonb;
  operator_id uuid;
begin
  if p_transfer_id is null then raise exception 'A stable transfer ID is required'; end if;
  operator_id:=public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  if jsonb_array_length(coalesce(p_payload->'items','[]'::jsonb))=0 then raise exception 'Add at least one item'; end if;
  fingerprint:=encode(extensions.digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'::text),'hex');

  select coalesce(jsonb_agg(jsonb_build_object('product_id',q.wholesale_product_id,'qty',q.qty) order by q.wholesale_product_id),'[]'::jsonb)
  into request_items
  from (
    select l.wholesale_product_id,sum((item->>'qty')::numeric) qty
    from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) item
    join public.retail_wholesale_product_links l on l.retail_product_id=(item->>'product_id')::uuid
    where coalesce((item->>'qty')::numeric,0)>0
    group by l.wholesale_product_id
  ) q;
  select * into existing from public.retail_wholesale_transfers where id=p_transfer_id for update;
  if found then
    if existing.request_fingerprint<>fingerprint then
      if existing.wholesale_response is null then
        raise exception 'This pending wholesale transfer belongs to an earlier version of the bill. Retry it without changing Wholesale quantities or ask an administrator to resolve transfer %',existing.retail_sale_reference;
      end if;
      if coalesce(existing.wholesale_request->'items','[]'::jsonb)<>request_items then
        raise exception 'Wholesale already posted this transfer. Prices and Retail payment may be corrected, but Wholesale items and quantities must remain unchanged';
      end if;
      normalized_payload:=coalesce(p_payload,'{}'::jsonb)||jsonb_build_object(
        'header',coalesce(p_payload->'header','{}'::jsonb)||jsonb_build_object('document_no',existing.retail_sale_reference)
      );
      update public.retail_wholesale_transfers set request_fingerprint=fingerprint,request_payload=normalized_payload,
        last_error=null,updated_at=now() where id=existing.id returning * into existing;
    end if;
    return to_jsonb(existing);
  end if;

  sale_reference:=coalesce(nullif(trim(p_payload->'header'->>'document_no'),''),public.next_document_no('invoice'));
  normalized_payload:=coalesce(p_payload,'{}'::jsonb)||jsonb_build_object(
    'header',coalesce(p_payload->'header','{}'::jsonb)||jsonb_build_object('document_no',sale_reference)
  );
  if jsonb_array_length(request_items)=0 then raise exception 'This bill has no enabled Wholesale Catalog items'; end if;
  if exists(
    select 1 from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) item
    join public.retail_wholesale_product_links l on l.retail_product_id=(item->>'product_id')::uuid
    where coalesce((item->>'qty')::numeric,0)>0 and not l.is_enabled
  ) then raise exception 'One or more Wholesale Catalog items are no longer available'; end if;

  insert into public.retail_wholesale_transfers(
    id,idempotency_key,request_fingerprint,status,next_step,retail_sale_reference,
    request_payload,wholesale_request,requested_by_staff_id
  ) values (
    p_transfer_id,'retail-transfer:'||p_transfer_id::text,fingerprint,'pending','wholesale_post',sale_reference,
    normalized_payload,jsonb_build_object('action','post_sale','idempotency_key','retail-transfer:'||p_transfer_id::text,
      'retail_sale_reference',sale_reference,'sale_date',coalesce(nullif(p_payload->'header'->>'document_date',''),current_date::text),'items',request_items),operator_id
  ) returning * into existing;
  return to_jsonb(existing);
end;
$$;

create or replace function public.post_retail_wholesale_transfer_v76(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  transfer public.retail_wholesale_transfers%rowtype;
  profile_id uuid; supplier_id_value uuid; credit_method public.payment_methods%rowtype;
  response_line jsonb; requested_line jsonb; invoice_item jsonb;
  link_row public.retail_wholesale_product_links%rowtype;
  purchase_items jsonb:='[]'::jsonb; invoice_items jsonb:='[]'::jsonb;
  purchase_result jsonb; invoice_result jsonb; authoritative_line jsonb;
  transfer_total numeric:=0; requested_qty numeric; returned_qty numeric;
  saved_retail_prices jsonb:='{}'::jsonb;
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  select * into transfer from public.retail_wholesale_transfers where id=p_transfer_id for update;
  if not found then raise exception 'Wholesale transfer not found'; end if;
  if transfer.status='retail_posted' then
    return jsonb_build_object('transfer_id',transfer.id,'invoice',jsonb_build_object('id',transfer.retail_invoice_document_id,
      'document_no',transfer.retail_sale_reference),'purchase',jsonb_build_object('id',transfer.retail_purchase_document_id),
      'wholesale',transfer.wholesale_response,'already_posted',true);
  end if;
  if transfer.wholesale_response is null or coalesce((transfer.wholesale_response->>'success')::boolean,false)=false then
    raise exception 'Wholesale has not posted this transfer yet';
  end if;

  for requested_line in select value from jsonb_array_elements(transfer.wholesale_request->'items') loop
    select value into authoritative_line from jsonb_array_elements(transfer.wholesale_response->'lines')
    where value->>'wholesale_product_id'=requested_line->>'product_id' limit 1;
    if authoritative_line is null then raise exception 'Wholesale response is missing product %',requested_line->>'product_id'; end if;
    requested_qty:=coalesce((requested_line->>'qty')::numeric,0);
    returned_qty:=coalesce((authoritative_line->>'qty')::numeric,0);
    if requested_qty<>returned_qty then raise exception 'Wholesale quantity mismatch for %',requested_line->>'product_id'; end if;
    select * into link_row from public.retail_wholesale_product_links
    where wholesale_product_id=(requested_line->>'product_id')::uuid for update;
    if not found then raise exception 'Wholesale product link is missing'; end if;
    saved_retail_prices:=jsonb_set(saved_retail_prices,array[link_row.retail_product_id::text],
      to_jsonb((select selling_price from public.products where id=link_row.retail_product_id)),true);
    purchase_items:=purchase_items||jsonb_build_array(jsonb_build_object(
      'product_id',link_row.retail_product_id,'item_code',authoritative_line->>'item_code',
      'description',authoritative_line->>'product_name','qty',returned_qty,
      'unit_cost',coalesce((authoritative_line->>'transfer_unit_price')::numeric,0)
    ));
    transfer_total:=transfer_total+round(returned_qty*coalesce((authoritative_line->>'transfer_unit_price')::numeric,0),2);
  end loop;
  if abs(transfer_total-coalesce((transfer.wholesale_response->>'transfer_total')::numeric,0))>0.01 then
    raise exception 'Wholesale transfer total does not match its authoritative lines';
  end if;

  select id into profile_id from public.customers where lower(trim(name))='gatronix wholesale' limit 1;
  if profile_id is null then
    insert into public.customers(name,is_customer,is_supplier) values('Gatronix Wholesale',false,true) returning id into profile_id;
  else update public.customers set is_supplier=true,updated_at=now() where id=profile_id;
  end if;
  select id into supplier_id_value from public.suppliers where lower(trim(name))='gatronix wholesale' limit 1;
  if supplier_id_value is null then insert into public.suppliers(name) values('Gatronix Wholesale') returning id into supplier_id_value; end if;
  select * into credit_method from public.payment_methods where lower(trim(name))='credit' and is_active limit 1;
  if not found or coalesce(credit_method.is_paid_method,true) then raise exception 'An active non-paid Credit payment method is required'; end if;

  perform set_config('shop_pos.retail_wholesale_transfer_id',transfer.id::text,true);
  perform set_config('shop_pos.retail_wholesale_operator_id',transfer.requested_by_staff_id::text,true);
  purchase_result:=public.save_purchase_like_document_v65(
    jsonb_build_object('document_type','purchase','supplier_id',supplier_id_value,'customer_id',profile_id,
      'document_date',transfer.request_payload->'header'->>'document_date','external_document_no',transfer.wholesale_document_no,
      'notes','Automatic JIT purchase for Retail sale '||transfer.retail_sale_reference),
    purchase_items,
    jsonb_build_array(jsonb_build_object('payment_method_id',credit_method.id,'payment_method_name',credit_method.name,'amount',transfer_total))
  );

  -- Normal purchase receiving may preserve markup by recalculating selling_price.
  -- A linked product's Retail price is independently owned, so restore it before
  -- the sale is validated and posted.
  for requested_line in select value from jsonb_array_elements(transfer.wholesale_request->'items') loop
    select * into link_row from public.retail_wholesale_product_links
    where wholesale_product_id=(requested_line->>'product_id')::uuid;
    update public.products set selling_price=(saved_retail_prices->>link_row.retail_product_id::text)::numeric,updated_at=now()
    where id=link_row.retail_product_id;
  end loop;

  for invoice_item in select value from jsonb_array_elements(transfer.request_payload->'items') loop
    authoritative_line:=null;
    select l.* into link_row from public.retail_wholesale_product_links l where l.retail_product_id=(invoice_item->>'product_id')::uuid;
    if found and coalesce((invoice_item->>'qty')::numeric,0)>0 then
      select value into authoritative_line from jsonb_array_elements(transfer.wholesale_response->'lines')
      where value->>'wholesale_product_id'=link_row.wholesale_product_id::text limit 1;
      if authoritative_line is not null then
        invoice_item:=jsonb_set(invoice_item,'{unit_cost}',to_jsonb(coalesce((authoritative_line->>'transfer_unit_price')::numeric,0)),true);
      end if;
    end if;
    invoice_items:=invoice_items||jsonb_build_array(invoice_item);
  end loop;
  invoice_result:=public.save_pos_invoice_v74(transfer.request_payload->'header',invoice_items,transfer.request_payload->'payments');

  update public.retail_wholesale_product_links l set
    last_wholesale_available_qty=greatest(l.last_wholesale_available_qty-q.qty,0),
    last_transfer_price=q.price,last_synced_at=now(),updated_at=now()
  from (
    select (line->>'wholesale_product_id')::uuid wholesale_product_id,(line->>'qty')::numeric qty,
      (line->>'transfer_unit_price')::numeric price
    from jsonb_array_elements(transfer.wholesale_response->'lines') line
  ) q where l.wholesale_product_id=q.wholesale_product_id;

  update public.retail_wholesale_transfers set status='retail_posted',next_step='complete',
    retail_purchase_document_id=(purchase_result->>'id')::uuid,retail_invoice_document_id=(invoice_result->>'id')::uuid,
    last_error=null,retail_posted_at=now(),updated_at=now()
  where id=transfer.id;
  return jsonb_build_object('transfer_id',transfer.id,'invoice',invoice_result,'purchase',purchase_result,
    'wholesale',transfer.wholesale_response,'already_posted',false);
end;
$$;

create or replace function public.get_pending_retail_wholesale_transfers_v76()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  perform public.authorize_retail_wholesale_admin_v76();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]'::jsonb) into result
  from (
    select t.id,t.idempotency_key,t.status,t.next_step,t.retail_sale_reference,t.wholesale_document_no,
      t.wholesale_transfer_total,t.attempt_count,t.last_error,t.created_at,t.updated_at,
      s.full_name as requested_by
    from public.retail_wholesale_transfers t
    left join public.staff s on s.id=t.requested_by_staff_id
    where t.status<>'retail_posted'
  ) x;
  return result;
end;
$$;

revoke all on function public.sync_retail_wholesale_catalog_v76(jsonb) from public;
grant execute on function public.sync_retail_wholesale_catalog_v76(jsonb) to service_role;
revoke all on function public.authorize_retail_wholesale_catalog_v76() from public;
revoke all on function public.authorize_retail_wholesale_admin_v76() from public;
revoke all on function public.prepare_retail_wholesale_transfer_v76(uuid,jsonb) from public;
revoke all on function public.post_retail_wholesale_transfer_v76(uuid) from public;
revoke all on function public.get_pending_retail_wholesale_transfers_v76() from public;
grant execute on function public.authorize_retail_wholesale_catalog_v76() to authenticated;
grant execute on function public.authorize_retail_wholesale_admin_v76() to authenticated;
grant execute on function public.prepare_retail_wholesale_transfer_v76(uuid,jsonb) to authenticated;
grant execute on function public.post_retail_wholesale_transfer_v76(uuid) to authenticated;
grant execute on function public.get_pending_retail_wholesale_transfers_v76() to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='retail_wholesale_product_links') then
    alter publication supabase_realtime add table public.retail_wholesale_product_links;
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
