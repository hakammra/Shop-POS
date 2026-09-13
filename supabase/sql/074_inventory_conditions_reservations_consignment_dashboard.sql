-- v74: stock-condition documents, customer reservations/advances, and consignment stock.
-- Run once after 073_random_five_character_job_codes.sql.

begin;

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check check (document_type in (
  'invoice', 'unconfirmed_sale', 'quotation', 'reservation',
  'purchase', 'stock_in_transit', 'stock_receiving', 'refund', 'trade_in',
  'stock_adjustment', 'stock_condition_transfer', 'consignment_intake', 'consignment_return',
  'job', 'customer_payment', 'supplier_payment', 'expense', 'other_income',
  'account_transfer', 'online_order', 'cod_order'
));

alter table public.documents
  add column if not exists reservation_stock_reserved boolean not null default false;

alter table public.document_items
  add column if not exists stock_from_bucket text,
  add column if not exists stock_to_bucket text;

alter table public.document_items drop constraint if exists document_items_stock_from_bucket_check;
alter table public.document_items add constraint document_items_stock_from_bucket_check
  check (stock_from_bucket is null or stock_from_bucket in ('sellable', 'damaged', 'checking'));
alter table public.document_items drop constraint if exists document_items_stock_to_bucket_check;
alter table public.document_items add constraint document_items_stock_to_bucket_check
  check (stock_to_bucket is null or stock_to_bucket in ('sellable', 'damaged', 'checking'));

alter table public.products
  add column if not exists inventory_ownership text not null default 'owned',
  add column if not exists consignment_owner_id uuid references public.customers(id) on delete restrict,
  add column if not exists consignment_unit_payout numeric(12,2);

alter table public.products drop constraint if exists products_inventory_ownership_check;
alter table public.products add constraint products_inventory_ownership_check
  check (inventory_ownership in ('owned', 'consignment'));
alter table public.products drop constraint if exists products_consignment_unit_payout_check;
alter table public.products add constraint products_consignment_unit_payout_check
  check (consignment_unit_payout is null or consignment_unit_payout >= 0);

create table if not exists public.consignment_sale_ledger (
  id uuid primary key default gen_random_uuid(),
  document_item_id uuid not null unique references public.document_items(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  owner_id uuid not null references public.customers(id) on delete restrict,
  qty numeric(12,3) not null,
  unit_payout numeric(12,2) not null,
  balance_delta numeric(12,2) not null,
  created_at timestamptz not null default now()
);

alter table public.consignment_sale_ledger enable row level security;
revoke all on public.consignment_sale_ledger from anon, authenticated;
grant select on public.consignment_sale_ledger to authenticated;
drop policy if exists "authenticated consignment ledger" on public.consignment_sale_ledger;
create policy "authenticated consignment ledger" on public.consignment_sale_ledger
  for select to authenticated using (true);

create index if not exists consignment_sale_ledger_owner_idx
  on public.consignment_sale_ledger(owner_id, created_at desc);
create index if not exists consignment_sale_ledger_document_idx
  on public.consignment_sale_ledger(document_id);

create or replace function public.next_document_no(p_document_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare account_code text; doc_year integer; short_year text; next_no integer;
begin
  account_code := case p_document_type
    when 'invoice' then '100' when 'sale' then '100' when 'unconfirmed_sale' then '105'
    when 'online_order' then '110' when 'cod_order' then '120' when 'reservation' then '130'
    when 'purchase' then '200' when 'stock_in_transit' then '300' when 'quotation' then '400'
    when 'refund' then '500' when 'stock_adjustment' then '600' when 'stock_condition_transfer' then '610'
    when 'consignment_intake' then '620' when 'consignment_return' then '630'
    when 'trade_in' then '700' when 'job' then '750' when 'customer_payment' then '800'
    when 'supplier_payment' then '850' when 'expense' then '900' when 'other_income' then '950'
    when 'account_transfer' then '980' else '999' end;
  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');
  insert into public.document_sequences(document_type, document_year, last_no)
  values(p_document_type, doc_year, 1)
  on conflict(document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;
  return short_year || account_code || lpad(next_no::text, 5, '0');
end;
$$;

create or replace function public.audit_document_operator_v38()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare operator_id uuid; needed_permission text;
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  operator_id := public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if tg_op = 'DELETE' then
    if old.document_type = 'invoice' then
      if current_setting('shop_pos.sales_edit_cleanup_id', true) = old.id::text
         and public.has_pos_permission_v38('edit_sales_documents') then return old; end if;
      if not public.has_pos_permission_v38('delete_sales_documents') then
        raise exception 'Delete finalized sales documents permission required';
      end if;
      return old;
    end if;
    if not public.has_pos_permission_v38('delete_documents') then
      raise exception 'You do not have permission to delete documents';
    end if;
    return old;
  end if;
  needed_permission := case new.document_type
    when 'invoice' then 'pos_sales' when 'unconfirmed_sale' then 'pos_sales'
    when 'reservation' then 'create_quotes' when 'quotation' then 'create_quotes'
    when 'cod_order' then 'manage_cod_orders' when 'online_order' then 'manage_online_orders'
    when 'job' then 'manage_jobs' when 'purchase' then 'manage_inventory_documents'
    when 'stock_in_transit' then 'manage_inventory_documents' when 'stock_receiving' then 'manage_inventory_documents'
    when 'stock_adjustment' then 'manage_inventory_documents' when 'stock_condition_transfer' then 'manage_inventory_documents'
    when 'consignment_intake' then 'manage_inventory_documents' when 'consignment_return' then 'manage_inventory_documents'
    when 'trade_in' then 'manage_inventory_documents' when 'customer_payment' then 'manage_parties'
    when 'supplier_payment' then 'manage_parties' when 'expense' then 'manage_cashflow'
    when 'other_income' then 'manage_cashflow' when 'account_transfer' then 'manage_cashflow'
    when 'refund' then 'process_returns' else 'view_documents' end;
  if not public.has_pos_permission_v38(needed_permission) then
    raise exception 'The active user does not have permission for this document action';
  end if;
  if tg_op = 'INSERT' then
    new.created_by_staff_id := operator_id;
    if new.document_type = 'cod_order' then new.order_taken_by := operator_id; end if;
  else
    new.created_by_staff_id := old.created_by_staff_id;
    if new.document_type = 'cod_order' then
      new.order_taken_by := coalesce(old.order_taken_by, old.created_by_staff_id, operator_id);
    end if;
  end if;
  new.updated_by_staff_id := operator_id;
  return new;
end;
$$;

create or replace function public.validate_consignment_product_v74()
returns trigger
language plpgsql
set search_path = public
as $$
declare stock_row public.stock_balances%rowtype;
begin
  new.inventory_ownership := coalesce(new.inventory_ownership, 'owned');
  if new.inventory_ownership = 'consignment' then
    if not coalesce(new.track_inventory, true) then raise exception 'A consignment product must track inventory'; end if;
    if new.consignment_owner_id is null then raise exception 'Select the owner for a consignment product'; end if;
    new.consignment_unit_payout := greatest(coalesce(new.consignment_unit_payout, new.avg_cost, 0), 0);
    new.avg_cost := new.consignment_unit_payout;
  else
    new.consignment_owner_id := null;
    new.consignment_unit_payout := null;
  end if;
  if tg_op = 'UPDATE' and (
      old.inventory_ownership is distinct from new.inventory_ownership
      or old.consignment_owner_id is distinct from new.consignment_owner_id
    ) then
    if exists(select 1 from public.document_items where product_id=new.id) then
      raise exception 'Document history already exists for %. Create a new product code for a different owner or shop-owned batch',new.item_code;
    end if;
    select * into stock_row from public.stock_balances where product_id = new.id;
    if found and (
      coalesce(stock_row.sellable_qty,0) <> 0 or coalesce(stock_row.reserved_qty,0) <> 0
      or coalesce(stock_row.in_transit_qty,0) <> 0 or coalesce(stock_row.damaged_qty,0) <> 0
      or coalesce(stock_row.checking_qty,0) <> 0
    ) then raise exception 'Stock must be zero before changing ownership or consignment owner for %', new.item_code; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_consignment_product_v74_trigger on public.products;
create trigger validate_consignment_product_v74_trigger
before insert or update on public.products
for each row execute function public.validate_consignment_product_v74();

create or replace view public.product_stock_view
with (security_invoker = true)
as
select
  p.id as product_id, p.item_code, p.name, p.category_id, p.barcode, p.selling_price, p.avg_cost,
  case when coalesce(p.avg_cost,0) <= 0 then 0 else round(((coalesce(p.selling_price,0)-coalesce(p.avg_cost,0))/nullif(p.avg_cost,0))*100,2) end as markup_percent,
  p.min_stock_level, p.online_visible, p.is_active, p.status,
  c.name as category_name, c.path as category_path, c.parent_id as category_parent_id, b.name as brand_name,
  coalesce(s.sellable_qty,0) as sellable_qty, coalesce(s.sellable_qty,0) as quantity,
  coalesce(s.reserved_qty,0) as reserved_qty, coalesce(s.damaged_qty,0) as damaged_qty,
  coalesce(s.checking_qty,0) as checking_qty, coalesce(s.sellable_qty,0)-coalesce(s.reserved_qty,0) as available_qty,
  coalesce(s.in_transit_qty,0) as in_transit_qty,
  coalesce(s.sellable_qty,0)*coalesce(p.avg_cost,0) as total_cost_value,
  coalesce(s.sellable_qty,0)*coalesce(p.selling_price,0) as total_sale_value,
  coalesce(s.in_transit_qty,0)*coalesce(p.avg_cost,0) as in_transit_value,
  (coalesce(p.track_inventory,true) and coalesce(s.sellable_qty,0) <= coalesce(p.min_stock_level,1)) as is_low_stock,
  p.warranty_months, p.serial_required, p.track_inventory,
  p.inventory_ownership, p.consignment_owner_id, p.consignment_unit_payout,
  owner.name as consignment_owner_name
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id
left join public.customers owner on owner.id = p.consignment_owner_id;

grant select on public.product_stock_view to authenticated;

create or replace function public.stock_bucket_qty_v74(p_stock public.stock_balances, p_bucket text)
returns numeric language sql immutable as $$
  select case p_bucket when 'sellable' then coalesce((p_stock).sellable_qty,0)
    when 'damaged' then coalesce((p_stock).damaged_qty,0)
    when 'checking' then coalesce((p_stock).checking_qty,0) else 0 end;
$$;

create or replace function public.save_stock_condition_transfer_v74(
  p_product_id uuid, p_qty numeric, p_from_bucket text, p_to_bucket text,
  p_notes text, p_document_date date default current_date
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare product_row public.products%rowtype; stock_row public.stock_balances%rowtype;
  doc_id uuid := gen_random_uuid(); doc_no text; qty_value numeric(12,3); item_value numeric(12,2);
begin
  if not public.has_pos_permission_v38('manage_inventory_documents') then raise exception 'Inventory-document permission required'; end if;
  qty_value := coalesce(p_qty,0);
  if qty_value <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_from_bucket not in ('sellable','damaged','checking') or p_to_bucket not in ('sellable','damaged','checking') or p_from_bucket = p_to_bucket then
    raise exception 'Choose two different valid stock conditions';
  end if;
  if nullif(trim(coalesce(p_notes,'')),'') is null then raise exception 'Enter a reason or reference'; end if;
  select * into product_row from public.products where id = p_product_id for update;
  if not found or not coalesce(product_row.track_inventory,true) then raise exception 'Tracked product not found'; end if;
  insert into public.stock_balances(product_id) values(p_product_id) on conflict(product_id) do nothing;
  select * into stock_row from public.stock_balances where product_id = p_product_id for update;
  if public.stock_bucket_qty_v74(stock_row,p_from_bucket) < qty_value then
    raise exception 'Only % units are in % stock', public.stock_bucket_qty_v74(stock_row,p_from_bucket), p_from_bucket;
  end if;
  if p_from_bucket = 'sellable' and stock_row.sellable_qty - qty_value < stock_row.reserved_qty then
    raise exception 'Reserved units cannot be moved. Only % sellable units are available', stock_row.sellable_qty-stock_row.reserved_qty;
  end if;
  update public.stock_balances set
    sellable_qty = sellable_qty + case when p_to_bucket='sellable' then qty_value when p_from_bucket='sellable' then -qty_value else 0 end,
    damaged_qty = damaged_qty + case when p_to_bucket='damaged' then qty_value when p_from_bucket='damaged' then -qty_value else 0 end,
    checking_qty = checking_qty + case when p_to_bucket='checking' then qty_value when p_from_bucket='checking' then -qty_value else 0 end,
    updated_at = now() where product_id = p_product_id;
  doc_no := public.next_document_no('stock_condition_transfer');
  insert into public.documents(id,document_no,document_type,status,document_date,total_amount,paid_amount,balance_amount,currency,notes,created_by)
  values(doc_id,doc_no,'stock_condition_transfer','completed',coalesce(p_document_date,current_date),0,0,0,'LKR',trim(p_notes),auth.uid());
  item_value := round(qty_value*coalesce(product_row.avg_cost,0),2);
  insert into public.document_items(document_id,product_id,item_code,description,qty,unit_price,unit_cost,line_total,stock_from_bucket,stock_to_bucket)
  values(doc_id,product_row.id,product_row.item_code,product_row.name,qty_value,0,product_row.avg_cost,item_value,p_from_bucket,p_to_bucket);
  insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
  values
    (p_product_id,doc_id,'stock_adjustment',-qty_value,product_row.avg_cost,initcap(p_from_bucket)||' -> '||initcap(p_to_bucket)||': '||trim(p_notes),auth.uid()),
    (p_product_id,doc_id,'stock_adjustment',qty_value,product_row.avg_cost,initcap(p_from_bucket)||' -> '||initcap(p_to_bucket)||': '||trim(p_notes),auth.uid());
  return jsonb_build_object('id',doc_id,'document_no',doc_no);
end;
$$;

create or replace function public.apply_reservation_stock_v74(p_document_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare doc public.documents%rowtype; item record; available numeric;
begin
  select * into doc from public.documents where id=p_document_id for update;
  if not found or doc.document_type <> 'reservation' then raise exception 'Reservation not found'; end if;
  if doc.reservation_stock_reserved then return; end if;
  for item in select di.* from public.document_items di join public.products p on p.id=di.product_id
    where di.document_id=p_document_id and coalesce(p.track_inventory,true)
  loop
    insert into public.stock_balances(product_id) values(item.product_id) on conflict(product_id) do nothing;
    select sellable_qty-reserved_qty into available from public.stock_balances where product_id=item.product_id for update;
    if available < item.qty then raise exception 'Not enough available stock for %. Available %, requested %', coalesce(item.item_code,item.description),available,item.qty; end if;
    update public.stock_balances set reserved_qty=reserved_qty+item.qty,updated_at=now() where product_id=item.product_id;
    insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
    values(item.product_id,p_document_id,'reserve',item.qty,item.unit_cost,'Customer reservation',auth.uid());
  end loop;
  update public.documents set reservation_stock_reserved=true,updated_at=now() where id=p_document_id;
end;
$$;

create or replace function public.release_reservation_stock_v74(p_document_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare doc public.documents%rowtype; item record;
begin
  select * into doc from public.documents where id=p_document_id for update;
  if not found or doc.document_type <> 'reservation' then raise exception 'Reservation not found'; end if;
  if not doc.reservation_stock_reserved then return; end if;
  for item in select di.* from public.document_items di join public.products p on p.id=di.product_id
    where di.document_id=p_document_id and coalesce(p.track_inventory,true)
  loop
    update public.stock_balances set reserved_qty=greatest(reserved_qty-item.qty,0),updated_at=now() where product_id=item.product_id;
    insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
    values(item.product_id,p_document_id,'release_reserve',-item.qty,item.unit_cost,'Customer reservation released',auth.uid());
  end loop;
  update public.documents set reservation_stock_reserved=false,updated_at=now() where id=p_document_id;
end;
$$;

create or replace function public.sync_reservation_advance_accounting_v74(p_document_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare doc public.documents%rowtype; entry_id uuid; advance numeric(14,2);
begin
  delete from public.accounting_journal_entries where source_type='reservation_advance' and source_key=p_document_id::text;
  select * into doc from public.documents where id=p_document_id and document_type='reservation';
  if not found then return; end if;
  select round(coalesce(sum(case when entry_type='cash_in' then amount when entry_type='cash_out' then -amount else 0 end),0),2)
  into advance from public.cashflow_entries where document_id=p_document_id;
  if advance<=0.004 then return; end if;
  insert into public.accounting_journal_entries(source_type,source_key,source_document_id,entry_date,reference_no,description,is_manual)
  values('reservation_advance',doc.id::text,doc.id,coalesce(doc.document_date::date,doc.created_at::date),doc.document_no,'Customer reservation advance',false)
  returning id into entry_id;
  perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounting_difference'),advance,0,'Replace automatic balancing line');
  perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),0,advance,'Advance held as customer credit');
end;
$$;

create or replace function public.save_reservation_v74(p_header jsonb,p_items jsonb,p_payments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare doc_id uuid:=gen_random_uuid(); doc_no text; item jsonb; pay jsonb; pm record;
  customer_id_value uuid:=nullif(p_header->>'customer_id','')::uuid; total numeric:=0; advance numeric:=0; first_pm uuid;
begin
  if not (public.has_pos_permission_v38('create_quotes') or public.has_pos_permission_v38('pos_sales')) then raise exception 'Quotation or POS permission required'; end if;
  if customer_id_value is null then raise exception 'Select a named customer for a reservation'; end if;
  for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if nullif(item->>'product_id','') is null or coalesce((item->>'qty')::numeric,0)<=0 then raise exception 'Every reservation item needs a product and positive quantity'; end if;
    total:=total+coalesce(
      nullif(item->>'line_total','')::numeric,
      round((item->>'qty')::numeric*coalesce((item->>'unit_price')::numeric,0),2)
    );
  end loop;
  if total<=0 then raise exception 'Add at least one reservation item'; end if;
  perform public.validate_cheque_payments_v56(p_payments);
  for pay in select value from jsonb_array_elements(coalesce(p_payments,'[]'::jsonb)) loop
    select * into pm from public.payment_methods where id=(pay->>'payment_method_id')::uuid and is_active;
    if not found or not coalesce(pm.is_paid_method,true) then raise exception 'Reservation advances require an active paid payment method'; end if;
    if coalesce((pay->>'amount')::numeric,0)<=0 then raise exception 'Advance amount must be greater than zero'; end if;
    first_pm:=coalesce(first_pm,pm.id); advance:=advance+(pay->>'amount')::numeric;
  end loop;
  if advance>total+0.005 then raise exception 'Advance cannot exceed the reservation total'; end if;
  doc_no:=public.next_document_no('reservation');
  insert into public.documents(id,document_no,external_document_no,document_type,status,customer_id,total_amount,paid_amount,balance_amount,currency,payment_method_id,document_date,notes,created_by)
  values(doc_id,doc_no,nullif(p_header->>'external_document_no',''),'reservation','reserved',customer_id_value,total,advance,total-advance,'LKR',first_pm,coalesce(nullif(p_header->>'document_date','')::date,current_date),nullif(p_header->>'notes',''),auth.uid());
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.document_items(document_id,product_id,item_code,description,qty,unit_price,unit_cost,discount_type,discount_value,line_total)
    values(doc_id,(item->>'product_id')::uuid,item->>'item_code',item->>'description',(item->>'qty')::numeric,coalesce((item->>'unit_price')::numeric,0),coalesce((item->>'unit_cost')::numeric,0),coalesce(nullif(item->>'discount_type',''),'none'),coalesce((item->>'discount_value')::numeric,0),coalesce((item->>'line_total')::numeric,0));
  end loop;
  for pay in select value from jsonb_array_elements(coalesce(p_payments,'[]'::jsonb)) loop
    select * into pm from public.payment_methods where id=(pay->>'payment_method_id')::uuid;
    insert into public.cashflow_entries(document_id,entry_type,account_name,payment_method_id,amount,description,created_by)
    values(doc_id,'cash_in',pm.name,pm.id,(pay->>'amount')::numeric,'Reservation advance '||doc_no,auth.uid());
  end loop;
  if advance>0 then
    perform public.apply_customer_outstanding_delta(customer_id_value,-advance);
    update public.documents set party_balance_applied=true,party_balance_delta=-advance,party_balance_customer_id=customer_id_value where id=doc_id;
  end if;
  perform public.apply_reservation_stock_v74(doc_id);
  perform public.record_cheque_payments_v56(doc_id,p_payments,'in');
  perform public.sync_reservation_advance_accounting_v74(doc_id);
  return jsonb_build_object('id',doc_id,'document_no',doc_no,'advance',advance,'balance_amount',total-advance);
end;
$$;

create or replace function public.cancel_reservation_v74(p_document_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare doc public.documents%rowtype;
begin
  if not public.has_pos_permission_v38('create_quotes') then raise exception 'Quotation permission required'; end if;
  select * into doc from public.documents where id=p_document_id for update;
  if not found or doc.document_type<>'reservation' then raise exception 'Reservation not found'; end if;
  if doc.status='converted' then raise exception 'A converted reservation cannot be cancelled'; end if;
  perform public.release_reservation_stock_v74(p_document_id);
  update public.documents set status='cancelled',updated_at=now(),notes=concat_ws(E'\n',notes,'Reservation cancelled; any advance remains as customer credit until refunded or used.') where id=p_document_id;
  return jsonb_build_object('id',doc.id,'document_no',doc.document_no,'advance_kept_as_credit',doc.paid_amount);
end;
$$;

create or replace function public.save_pos_invoice_v74(p_header jsonb,p_items jsonb,p_payments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb; reservation_id uuid:=nullif(p_header->>'source_reservation_id','')::uuid; reservation_doc public.documents%rowtype;
begin
  if reservation_id is not null then
    select * into reservation_doc from public.documents where id=reservation_id for update;
    if not found or reservation_doc.document_type<>'reservation' or reservation_doc.status<>'reserved' then raise exception 'Active reservation not found'; end if;
    if reservation_doc.customer_id is distinct from nullif(p_header->>'customer_id','')::uuid then raise exception 'The invoice customer must match the reservation customer'; end if;
    perform public.release_reservation_stock_v74(reservation_id);
    p_header:=p_header||jsonb_build_object('use_existing_customer_credit',true);
  end if;
  result:=public.save_pos_invoice_v56(p_header,p_items,p_payments);
  if reservation_id is not null then
    update public.documents set status='converted',linked_document_id=(result->>'id')::uuid,updated_at=now(),notes=concat_ws(E'\n',notes,'Converted to invoice '||(result->>'document_no')) where id=reservation_id;
  end if;
  return result;
end;
$$;

create or replace function public.save_consignment_document_v74(
  p_document_type text,p_owner_id uuid,p_items jsonb,p_notes text,p_document_date date default current_date
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare doc_id uuid:=gen_random_uuid(); doc_no text; item jsonb; product_row public.products%rowtype;
  stock_row public.stock_balances%rowtype; qty_value numeric; payout numeric; source_bucket text; total_value numeric:=0; physical_qty numeric;
begin
  if not public.has_pos_permission_v38('manage_inventory_documents') then raise exception 'Inventory-document permission required'; end if;
  if p_document_type not in ('consignment_intake','consignment_return') then raise exception 'Invalid consignment document type'; end if;
  if p_owner_id is null then raise exception 'Select the consignment owner'; end if;
  if not exists(select 1 from public.customers where id=p_owner_id and coalesce(is_supplier,false)) then raise exception 'The owner profile must be marked as a supplier'; end if;
  doc_no:=public.next_document_no(p_document_type);
  insert into public.documents(id,document_no,document_type,status,customer_id,total_amount,paid_amount,balance_amount,currency,document_date,notes,created_by)
  values(doc_id,doc_no,p_document_type,'completed',p_owner_id,0,0,0,'LKR',coalesce(p_document_date,current_date),nullif(trim(p_notes),''),auth.uid());
  for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    qty_value:=coalesce((item->>'qty')::numeric,0); payout:=coalesce((item->>'unit_cost')::numeric,0); source_bucket:=coalesce(nullif(item->>'source_bucket',''),'sellable');
    if qty_value<=0 then raise exception 'Every consignment quantity must be greater than zero'; end if;
    select * into product_row from public.products where id=(item->>'product_id')::uuid for update;
    if not found or product_row.inventory_ownership<>'consignment' or product_row.consignment_owner_id is distinct from p_owner_id then raise exception '% is not assigned to this consignment owner',coalesce(product_row.item_code,item->>'item_code'); end if;
    insert into public.stock_balances(product_id) values(product_row.id) on conflict(product_id) do nothing;
    select * into stock_row from public.stock_balances where product_id=product_row.id for update;
    if p_document_type='consignment_intake' then
      physical_qty:=stock_row.sellable_qty+stock_row.damaged_qty+stock_row.checking_qty;
      payout:=greatest(payout,0);
      update public.products set avg_cost=case when physical_qty+qty_value>0 then round((physical_qty*coalesce(avg_cost,0)+qty_value*payout)/(physical_qty+qty_value),2) else payout end,
        consignment_unit_payout=payout,updated_at=now() where id=product_row.id;
      update public.stock_balances set sellable_qty=sellable_qty+qty_value,updated_at=now() where product_id=product_row.id;
      insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
      values(product_row.id,doc_id,'stock_adjustment',qty_value,payout,'Consignment intake',auth.uid());
    else
      if source_bucket not in ('sellable','damaged','checking') then raise exception 'Invalid return condition'; end if;
      if public.stock_bucket_qty_v74(stock_row,source_bucket)<qty_value then raise exception 'Not enough % stock for %',source_bucket,product_row.item_code; end if;
      if source_bucket='sellable' and stock_row.sellable_qty-qty_value<stock_row.reserved_qty then raise exception 'Reserved units cannot be returned to the owner'; end if;
      update public.stock_balances set
        sellable_qty=sellable_qty+case when source_bucket='sellable' then -qty_value else 0 end,
        damaged_qty=damaged_qty+case when source_bucket='damaged' then -qty_value else 0 end,
        checking_qty=checking_qty+case when source_bucket='checking' then -qty_value else 0 end,
        updated_at=now() where product_id=product_row.id;
      payout:=coalesce(product_row.avg_cost,product_row.consignment_unit_payout,0);
      insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
      values(product_row.id,doc_id,'stock_adjustment',-qty_value,payout,'Consignment returned to owner from '||source_bucket,auth.uid());
    end if;
    insert into public.document_items(document_id,product_id,item_code,description,qty,unit_price,unit_cost,line_total,stock_from_bucket,stock_to_bucket)
    values(doc_id,product_row.id,product_row.item_code,product_row.name,qty_value,0,payout,round(qty_value*payout,2),case when p_document_type='consignment_return' then source_bucket end,case when p_document_type='consignment_intake' then 'sellable' end);
    total_value:=total_value+round(qty_value*payout,2);
  end loop;
  if not exists(select 1 from public.document_items where document_id=doc_id) then raise exception 'Add at least one consignment item'; end if;
  update public.documents set total_amount=total_value,updated_at=now() where id=doc_id;
  return jsonb_build_object('id',doc_id,'document_no',doc_no,'inventory_value',total_value);
end;
$$;

create or replace function public.apply_consignment_sale_line_v74(p_item_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare line record; payout numeric; delta numeric; owner_id_value uuid;
begin
  if exists(select 1 from public.consignment_sale_ledger where document_item_id=p_item_id) then return; end if;
  if current_setting('shop_pos.restore_mode',true)='on' then return; end if;
  select di.*,d.document_type,d.status,p.inventory_ownership,p.consignment_owner_id,p.consignment_unit_payout
  into line from public.document_items di join public.documents d on d.id=di.document_id join public.products p on p.id=di.product_id where di.id=p_item_id;
  if not found or line.document_type not in ('invoice','refund') or line.inventory_ownership<>'consignment' or line.consignment_owner_id is null or coalesce(line.qty,0)=0 then return; end if;
  owner_id_value:=line.consignment_owner_id;
  payout:=coalesce(nullif(line.unit_cost,0),line.consignment_unit_payout,0);
  if line.qty < 0 and line.source_document_item_id is not null then
    select owner_id,unit_payout into owner_id_value,payout
    from public.consignment_sale_ledger where document_item_id=line.source_document_item_id;
    owner_id_value:=coalesce(owner_id_value,line.consignment_owner_id);
    payout:=coalesce(payout,nullif(line.unit_cost,0),line.consignment_unit_payout,0);
  end if;
  delta:=case when line.qty>0 then -1 else 1 end*round(abs(line.qty)*payout,2);
  perform public.apply_customer_outstanding_delta(owner_id_value,delta);
  insert into public.consignment_sale_ledger(document_item_id,document_id,product_id,owner_id,qty,unit_payout,balance_delta)
  values(line.id,line.document_id,line.product_id,owner_id_value,line.qty,payout,delta);
end;
$$;

create or replace function public.reverse_consignment_sale_line_v74(p_item_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare ledger_row public.consignment_sale_ledger%rowtype;
begin
  select * into ledger_row from public.consignment_sale_ledger where document_item_id=p_item_id for update;
  if not found then return; end if;
  if current_setting('shop_pos.restore_mode',true)='on' then
    delete from public.consignment_sale_ledger where id=ledger_row.id;
    return;
  end if;
  perform public.apply_customer_outstanding_delta(ledger_row.owner_id,-ledger_row.balance_delta);
  delete from public.consignment_sale_ledger where id=ledger_row.id;
end;
$$;

create or replace function public.consignment_sale_before_change_v74()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.reverse_consignment_sale_line_v74(old.id);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create or replace function public.consignment_sale_after_change_v74()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.apply_consignment_sale_line_v74(new.id); return new; end;
$$;

create or replace function public.normalize_consignment_sale_item_v74()
returns trigger language plpgsql security definer set search_path = public as $$
declare doc_type text; product_row public.products%rowtype; original_cost numeric;
begin
  if current_setting('shop_pos.restore_mode',true)='on' then return new; end if;
  select document_type into doc_type from public.documents where id=new.document_id;
  if doc_type not in ('invoice','refund') or new.product_id is null then return new; end if;
  select * into product_row from public.products where id=new.product_id;
  if not found or product_row.inventory_ownership<>'consignment' then return new; end if;
  if coalesce(new.qty,0)<0 and new.source_document_item_id is not null then
    select unit_cost into original_cost from public.document_items where id=new.source_document_item_id;
  end if;
  new.unit_cost:=coalesce(original_cost,product_row.avg_cost,product_row.consignment_unit_payout,0);
  return new;
end;
$$;

drop trigger if exists normalize_consignment_sale_item_v74_trigger on public.document_items;
create trigger normalize_consignment_sale_item_v74_trigger
before insert or update on public.document_items
for each row execute function public.normalize_consignment_sale_item_v74();
drop trigger if exists consignment_sale_before_change_v74_trigger on public.document_items;
create trigger consignment_sale_before_change_v74_trigger before update or delete on public.document_items for each row execute function public.consignment_sale_before_change_v74();
drop trigger if exists consignment_sale_after_change_v74_trigger on public.document_items;
create trigger consignment_sale_after_change_v74_trigger after insert or update on public.document_items for each row execute function public.consignment_sale_after_change_v74();

create or replace function public.sync_consignment_accounting_v74(p_document_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare doc public.documents%rowtype; entry_id uuid; payable_change numeric(14,2);
begin
  delete from public.accounting_journal_entries where source_type='consignment' and source_key=p_document_id::text;
  select * into doc from public.documents where id=p_document_id;
  if not found then return; end if;
  select round(coalesce(sum(-balance_delta),0),2) into payable_change
  from public.consignment_sale_ledger where document_id=p_document_id;
  if abs(payable_change)<0.005 then return; end if;
  insert into public.accounting_journal_entries(source_type,source_key,source_document_id,entry_date,reference_no,description,is_manual)
  values('consignment',doc.id::text,doc.id,coalesce(doc.document_date::date,doc.created_at::date),doc.document_no,'Consignment owner payable',false)
  returning id into entry_id;
  if payable_change>0 then
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('inventory'),payable_change,0,'Remove consignment COGS from shop-owned inventory');
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),0,payable_change,'Amount owed to consignment owner');
  else
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),abs(payable_change),0,'Reverse consignment owner payable');
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('inventory'),0,abs(payable_change),'Reverse consignment inventory offset');
  end if;
end;
$$;

create or replace function public.consignment_accounting_trigger_v74()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_consignment_accounting_v74(case when tg_op='DELETE' then old.document_id else new.document_id end);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists consignment_accounting_v74_trigger on public.consignment_sale_ledger;
create trigger consignment_accounting_v74_trigger
after insert or update or delete on public.consignment_sale_ledger
for each row execute function public.consignment_accounting_trigger_v74();

-- Consignment stock is physically present but remains the owner's asset. The
-- invoice journal above is bridged from Inventory to Accounts Payable when it
-- sells, so the normal COGS calculation remains correct without overstating
-- shop-owned stock before sale.
create or replace function public.reconcile_inventory_ledger_v42()
returns void language plpgsql security definer set search_path = public as $$
declare entry_id uuid; inventory_actual numeric(14,2); transit_actual numeric(14,2); damaged_actual numeric(14,2);
  ledger_value numeric(14,2); difference_value numeric(14,2); offset_value numeric(14,2):=0; target record;
begin
  select round(coalesce(sum(sb.sellable_qty*p.avg_cost),0),2),
    round(coalesce(sum(sb.in_transit_qty*p.avg_cost),0),2),
    round(coalesce(sum((sb.damaged_qty+sb.checking_qty)*p.avg_cost),0),2)
  into inventory_actual,transit_actual,damaged_actual
  from public.stock_balances sb join public.products p on p.id=sb.product_id
    and coalesce(p.track_inventory,true) and coalesce(p.inventory_ownership,'owned')='owned';
  delete from public.accounting_journal_entries where source_type='system' and source_key='inventory-reconciliation';
  insert into public.accounting_journal_entries(source_type,source_key,entry_date,reference_no,description)
  values('system','inventory-reconciliation',current_date,'AUTO-STOCK','Automatic opening stock and inventory reconciliation') returning id into entry_id;
  for target in select * from (values ('inventory'::text,inventory_actual),('stock_in_transit'::text,transit_actual),('damaged_inventory'::text,damaged_actual)) as x(system_key,actual_value)
  loop
    select round(coalesce(sum(jl.debit-jl.credit),0),2) into ledger_value
    from public.accounting_journal_lines jl join public.accounting_journal_entries je on je.id=jl.journal_entry_id
    where jl.account_id=public.accounting_account_id_v42(target.system_key)
      and not (je.source_type='system' and je.source_key='inventory-reconciliation');
    difference_value:=round(target.actual_value-ledger_value,2);
    if difference_value>0 then
      perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42(target.system_key),difference_value,0,'Match current shop-owned stock valuation');
    elsif difference_value<0 then
      perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42(target.system_key),0,abs(difference_value),'Match current shop-owned stock valuation');
    end if;
    offset_value:=offset_value+difference_value;
  end loop;
  if offset_value>0 then
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('inventory_revaluation_equity'),0,offset_value,'Inventory opening/revaluation offset');
  elsif offset_value<0 then
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('inventory_revaluation_equity'),abs(offset_value),0,'Inventory opening/revaluation offset');
  end if;
  if not exists(select 1 from public.accounting_journal_lines where journal_entry_id=entry_id) then
    delete from public.accounting_journal_entries where id=entry_id;
  end if;
end;
$$;

create or replace function public.augment_consignment_backup_v74()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.snapshot:=coalesce(new.snapshot,'{}'::jsonb)||jsonb_build_object(
    'consignment_sale_ledger',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.consignment_sale_ledger x),'[]'::jsonb)
  );
  new.row_counts:=coalesce(new.row_counts,'{}'::jsonb)||jsonb_build_object(
    'consignment_sale_ledger',(select count(*) from public.consignment_sale_ledger)
  );
  new.schema_version:=greatest(coalesce(new.schema_version,31),74);
  new.snapshot_size_bytes:=pg_column_size(new.snapshot);
  return new;
end;
$$;

drop trigger if exists augment_consignment_backup_v74_trigger on public.app_backups;
create trigger augment_consignment_backup_v74_trigger
before insert or update of snapshot on public.app_backups
for each row execute function public.augment_consignment_backup_v74();

create or replace function public.restore_consignment_backup_v74()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status<>'restored' or not (new.snapshot?'consignment_sale_ledger') then return new; end if;
  delete from public.consignment_sale_ledger where true;
  insert into public.consignment_sale_ledger
  select * from jsonb_populate_recordset(null::public.consignment_sale_ledger,coalesce(new.snapshot->'consignment_sale_ledger','[]'::jsonb));
  return new;
end;
$$;

drop trigger if exists restore_consignment_backup_v74_trigger on public.app_backups;
create trigger restore_consignment_backup_v74_trigger
after update of status on public.app_backups
for each row execute function public.restore_consignment_backup_v74();

revoke all on function public.save_stock_condition_transfer_v74(uuid,numeric,text,text,text,date) from public;
revoke all on function public.save_reservation_v74(jsonb,jsonb,jsonb) from public;
revoke all on function public.cancel_reservation_v74(uuid) from public;
revoke all on function public.save_pos_invoice_v74(jsonb,jsonb,jsonb) from public;
revoke all on function public.save_consignment_document_v74(text,uuid,jsonb,text,date) from public;
revoke all on function public.stock_bucket_qty_v74(public.stock_balances,text) from public;
revoke all on function public.apply_reservation_stock_v74(uuid) from public;
revoke all on function public.release_reservation_stock_v74(uuid) from public;
revoke all on function public.sync_reservation_advance_accounting_v74(uuid) from public;
revoke all on function public.apply_consignment_sale_line_v74(uuid) from public;
revoke all on function public.reverse_consignment_sale_line_v74(uuid) from public;
revoke all on function public.consignment_sale_before_change_v74() from public;
revoke all on function public.consignment_sale_after_change_v74() from public;
revoke all on function public.normalize_consignment_sale_item_v74() from public;
revoke all on function public.sync_consignment_accounting_v74(uuid) from public;
revoke all on function public.consignment_accounting_trigger_v74() from public;
revoke all on function public.reconcile_inventory_ledger_v42() from public;
revoke all on function public.augment_consignment_backup_v74() from public;
revoke all on function public.restore_consignment_backup_v74() from public;
grant execute on function public.save_stock_condition_transfer_v74(uuid,numeric,text,text,text,date) to authenticated;
grant execute on function public.save_reservation_v74(jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.cancel_reservation_v74(uuid) to authenticated;
grant execute on function public.save_pos_invoice_v74(jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.save_consignment_document_v74(text,uuid,jsonb,text,date) to authenticated;

insert into public.assistant_pos_guides(topic,area,keywords,content) values
('Move stock between sellable, damaged, and checking','Stock',array['damaged on arrival','mark damaged','damaged stock','replace damaged','condition transfer','checking stock'],'Open Documents, choose Add, then Stock Condition Transfer. Select the product, the current condition, the new condition, quantity, and a reason. This moves the same physical units between Sellable, Damaged, and Checking without creating cashflow or changing cost. A supplier replacement is recorded as Damaged to Sellable when the replacement makes that stock saleable again.'),
('Reserve products and record an advance','Documents',array['reserve product','customer reservation','advance payment','deposit','reservation order'],'Open Documents, choose Add, then Reservation Order. Select a named customer, add products, and optionally enter the advance payment and method. Saving reserves the stock immediately and records the advance as both a payment movement and customer credit. Convert the reservation to Sales from Documents when supplied; its reserved stock is released inside the same transaction and the customer advance is applied to the invoice. Cancelling releases stock while leaving any advance as customer credit so it can be refunded or used later.'),
('Receive and sell consignment items','Inventory',array['consignment','sell for someone','not our stock','commission item','return to owner'],'Create a separate product/SKU and set Ownership to Consignment with its owner and agreed payout. Use Consignment Intake to receive quantity without creating a purchase payable or cashflow. When sold in POS, the agreed payout becomes cost of goods and is automatically added to the owner supplier balance; gross profit is the shop margin. Pay the owner with Supplier Payment. Use Consignment Return if the owner takes unsold sellable, damaged, or checking stock back.')
on conflict ((lower(topic))) do update set area=excluded.area,keywords=excluded.keywords,content=excluded.content,is_active=true,updated_at=now();

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='consignment_sale_ledger'
  ) then alter publication supabase_realtime add table public.consignment_sale_ledger; end if;
end $$;

notify pgrst, 'reload schema';
commit;
