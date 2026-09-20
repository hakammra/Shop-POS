-- v82: Final landed-cost receiving for Stock in Transit and unlinked POS
-- component credits used during upgrades.
-- Run once after 081_wholesale_sale_edit_and_cancellation.sql.

begin;

alter table public.documents
  add column if not exists source_goods_cost_amount numeric(12,2) not null default 0,
  add column if not exists landed_cost_amount numeric(12,2) not null default 0;

alter table public.document_items
  add column if not exists line_kind text not null default 'standard';

create index if not exists document_items_line_kind_v82_idx
  on public.document_items(line_kind)
  where line_kind <> 'standard';

-- Rebuild the linked receipt entry using the source transit value plus only the
-- arrival difference. The older generic accounting function assumed the source
-- and final purchase values were identical.
create or replace function public.sync_transit_arrival_accounting_v82(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc public.documents%rowtype;
  source_doc public.documents%rowtype;
  entry_id uuid;
  flow record;
  payment_account_id uuid;
  final_value numeric(14,2) := 0;
  goods_value numeric(14,2) := 0;
  total_debit numeric(14,2) := 0;
  total_credit numeric(14,2) := 0;
begin
  select * into doc from public.documents where id = p_document_id;
  if not found then return; end if;

  if doc.document_type='stock_in_transit' and coalesce(doc.source_goods_cost_amount,0)>0 then
    goods_value:=round(abs(doc.source_goods_cost_amount),2);
    final_value:=goods_value;
  elsif doc.document_type='purchase' and doc.linked_document_id is not null then
    select * into source_doc from public.documents where id = doc.linked_document_id and document_type = 'stock_in_transit';
    if not found then return; end if;
    select round(coalesce(nullif(sum(coalesce(di.line_total, di.qty * di.unit_cost)),0), abs(doc.total_amount), 0), 2)
    into final_value from public.document_items di where di.document_id = doc.id;
    goods_value := round(coalesce(nullif(doc.source_goods_cost_amount, 0), nullif(source_doc.source_goods_cost_amount,0), abs(source_doc.total_amount), 0), 2);
  else
    return;
  end if;

  delete from public.accounting_journal_entries
  where source_type = 'document' and source_key = doc.id::text;

  insert into public.accounting_journal_entries(
    source_type, source_key, source_document_id, entry_date, reference_no, description, is_manual
  ) values (
    'document', doc.id::text, doc.id, coalesce(doc.document_date::date, doc.created_at::date),
    doc.document_no, coalesce(nullif(doc.notes, ''), case when doc.document_type='stock_in_transit' then 'Goods paid and placed in transit' else 'Stock received with final landed cost' end), false
  ) returning id into entry_id;

  for flow in
    select cf.* from public.cashflow_entries cf
    where cf.document_id = doc.id and cf.entry_type in ('cash_in', 'cash_out')
    order by cf.created_at, cf.id
  loop
    payment_account_id := public.ensure_payment_account_v42(flow.payment_method_id);
    if flow.entry_type = 'cash_in' then
      perform public.add_accounting_line_v42(entry_id, payment_account_id, flow.amount, 0, flow.description);
    else
      perform public.add_accounting_line_v42(entry_id, payment_account_id, 0, flow.amount, flow.description);
    end if;
  end loop;

  if doc.document_type='stock_in_transit' then
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('stock_in_transit'), goods_value, 0, 'Goods paid and placed in transit');
  else
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('inventory'), final_value, 0, 'Inventory received at final landed cost');
    perform public.add_accounting_line_v42(entry_id, public.accounting_account_id_v42('stock_in_transit'), 0, goods_value, 'Goods value transferred from stock in transit');
  end if;

  select coalesce(sum(debit),0), coalesce(sum(credit),0)
  into total_debit,total_credit from public.accounting_journal_lines where journal_entry_id=entry_id;
  if total_debit > total_credit + 0.004 then
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),0,total_debit-total_credit,'Unpaid arrival or landed cost');
  elsif total_credit > total_debit + 0.004 then
    perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),total_credit-total_debit,0,'Arrival cost overpayment');
  end if;
end;
$$;

create or replace function public.transit_arrival_accounting_trigger_v82()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare target_id uuid;
begin
  target_id := case when tg_op='DELETE' then old.document_id else new.document_id end;
  perform public.sync_transit_arrival_accounting_v82(target_id);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.transit_arrival_document_accounting_trigger_v82()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op='DELETE' then return old; end if;
  perform public.sync_transit_arrival_accounting_v82(new.id);
  return new;
end;
$$;

drop trigger if exists zz_transit_arrival_documents_v82 on public.documents;
create trigger zz_transit_arrival_documents_v82
after insert or update on public.documents
for each row execute function public.transit_arrival_document_accounting_trigger_v82();

drop trigger if exists zz_transit_arrival_items_v82 on public.document_items;
create trigger zz_transit_arrival_items_v82
after insert or update or delete on public.document_items
for each row execute function public.transit_arrival_accounting_trigger_v82();

drop trigger if exists zz_transit_arrival_cashflow_v82 on public.cashflow_entries;
create trigger zz_transit_arrival_cashflow_v82
after insert or update or delete on public.cashflow_entries
for each row execute function public.transit_arrival_accounting_trigger_v82();

-- Stock in Transit records one goods payment for the whole shipment. Product
-- unit costs intentionally remain unassigned until the arrival workflow.
create or replace function public.save_stock_in_transit_v82(
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb,
  p_goods_total numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  item_count integer := 0;
  total_qty numeric := 0;
  goods_total numeric(12,2) := round(coalesce(p_goods_total,0),2);
  temporary_unit_cost numeric(12,2);
  internal_items jsonb;
  result jsonb;
  saved_document_id uuid;
  paid_total numeric(12,2);
  resulting_outstanding numeric(12,2);
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if not public.has_pos_permission_v38('manage_inventory_documents') then raise exception 'Inventory-document permission required'; end if;
  if goods_total<=0 then raise exception 'Enter the total goods amount paid for this shipment'; end if;

  for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if nullif(item->>'product_id','') is null or coalesce((item->>'qty')::numeric,0)<=0 then
      raise exception 'Every transit line must have a product and quantity greater than zero';
    end if;
    item_count:=item_count+1;
    total_qty:=total_qty+(item->>'qty')::numeric;
  end loop;
  if item_count=0 or total_qty<=0 then raise exception 'Add at least one transit product'; end if;

  -- The established purchase-like routine handles payment accounts, cheques,
  -- supplier balance and in-transit quantities. Give it a temporary positive
  -- allocation, then remove that estimate so arrival is the only place where
  -- product unit costs become authoritative.
  temporary_unit_cost:=greatest(round(goods_total/total_qty,2),0.01);
  select jsonb_agg(entry.value||jsonb_build_object('unit_cost',temporary_unit_cost))
  into internal_items from jsonb_array_elements(p_items) entry;

  result:=public.save_purchase_like_document_v65(
    p_header||jsonb_build_object('document_type','stock_in_transit'),
    internal_items,
    p_payments
  );
  saved_document_id:=(result->>'id')::uuid;

  update public.document_items
  set unit_cost=0,unit_price=0,line_total=0
  where document_id=saved_document_id;
  update public.stock_movements
  set unit_cost=0
  where document_id=saved_document_id and movement_type='stock_in_transit';
  select coalesce(d.paid_amount,0) into paid_total from public.documents d where d.id=saved_document_id;
  update public.documents
  set total_amount=goods_total,
      balance_amount=round(goods_total-paid_total,2),
      source_goods_cost_amount=goods_total,
      updated_at=now()
  where id=saved_document_id;

  resulting_outstanding:=public.apply_document_party_balance_v18(saved_document_id);
  perform public.sync_accounting_document_v42(saved_document_id);
  return result||jsonb_build_object(
    'total_amount',goods_total,
    'paid_amount',paid_total,
    'balance_amount',round(goods_total-paid_total,2),
    'new_outstanding',resulting_outstanding
  );
end;
$$;

create or replace function public.replace_stock_in_transit_v82(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb,
  p_goods_total numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  transit_doc public.documents%rowtype;
  item jsonb;
  item_count integer := 0;
  total_qty numeric := 0;
  goods_total numeric(12,2) := round(coalesce(p_goods_total,0),2);
  temporary_unit_cost numeric(12,2);
  internal_items jsonb;
  paid_total numeric(12,2);
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if not public.has_pos_permission_v38('manage_inventory_documents') then raise exception 'Inventory-document permission required'; end if;
  select * into transit_doc from public.documents where id=p_document_id for update;
  if not found or transit_doc.document_type<>'stock_in_transit' then raise exception 'Stock in Transit document not found'; end if;
  if transit_doc.status<>'in_transit' then raise exception 'Only an active in-transit document can be edited'; end if;
  if goods_total<=0 then raise exception 'Enter the total goods amount paid for this shipment'; end if;

  for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if nullif(item->>'product_id','') is null or coalesce((item->>'qty')::numeric,0)<=0 then
      raise exception 'Every transit line must have a product and quantity greater than zero';
    end if;
    item_count:=item_count+1;
    total_qty:=total_qty+(item->>'qty')::numeric;
  end loop;
  if item_count=0 or total_qty<=0 then raise exception 'Add at least one transit product'; end if;

  temporary_unit_cost:=greatest(round(goods_total/total_qty,2),0.01);
  select jsonb_agg(entry.value||jsonb_build_object('unit_cost',temporary_unit_cost))
  into internal_items from jsonb_array_elements(p_items) entry;
  perform public.replace_purchase_like_document_v72(
    p_document_id,
    p_header||jsonb_build_object('document_type','stock_in_transit'),
    internal_items,
    p_payments
  );

  update public.document_items set unit_cost=0,unit_price=0,line_total=0 where document_id=p_document_id;
  update public.stock_movements set unit_cost=0 where document_id=p_document_id and movement_type='stock_in_transit';
  select coalesce(d.paid_amount,0) into paid_total from public.documents d where d.id=p_document_id;
  update public.documents
  set total_amount=goods_total,
      balance_amount=round(goods_total-paid_total,2),
      source_goods_cost_amount=goods_total,
      updated_at=now()
  where id=p_document_id;
  perform public.apply_document_party_balance_v18(p_document_id);
  perform public.sync_accounting_document_v42(p_document_id);
end;
$$;

create or replace function public.receive_stock_in_transit_v82(
  p_transit_doc_id uuid,
  p_arrival_items jsonb,
  p_payment jsonb default '{}'::jsonb,
  p_arrival_date date default current_date,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transit_doc public.documents%rowtype;
  source_item public.document_items%rowtype;
  arrival_item jsonb;
  purchase_doc_id uuid := gen_random_uuid();
  purchase_doc_no text;
  final_unit_cost numeric(12,2);
  goods_total numeric(12,2) := 0;
  final_total numeric(12,2) := 0;
  shipping_cost numeric(12,2) := 0;
  payment_method public.payment_methods%rowtype;
  payment_method_id uuid;
  paid_total numeric(12,2);
  balance_total numeric(12,2);
  arrival_count integer;
begin
  if auth.uid() is null then raise exception 'Login required'; end if;
  if not public.has_pos_permission_v38('manage_inventory_documents') then raise exception 'Inventory-document permission required'; end if;

  select * into transit_doc from public.documents where id=p_transit_doc_id for update;
  if not found or transit_doc.document_type<>'stock_in_transit' then raise exception 'Stock in Transit document not found'; end if;
  if transit_doc.status<>'in_transit' then raise exception 'Only an active in-transit document can be marked arrived. Current status: %',transit_doc.status; end if;

  select count(*) into arrival_count from jsonb_array_elements(coalesce(p_arrival_items,'[]'::jsonb));
  if arrival_count<>(select count(*) from public.document_items where document_id=p_transit_doc_id) then
    raise exception 'Enter a final landed cost for every transit item';
  end if;

  for source_item in select * from public.document_items where document_id=p_transit_doc_id order by created_at,id loop
    select x.value into arrival_item
    from jsonb_array_elements(coalesce(p_arrival_items,'[]'::jsonb)) x
    where nullif(x.value->>'source_item_id','')::uuid=source_item.id;
    if arrival_item is null then raise exception 'Arrival cost is missing for %',coalesce(source_item.item_code,source_item.description); end if;
    if (select count(*) from jsonb_array_elements(p_arrival_items) x where nullif(x.value->>'source_item_id','')::uuid=source_item.id)<>1 then
      raise exception 'Each transit line must appear exactly once';
    end if;
    final_unit_cost:=round(coalesce((arrival_item->>'final_unit_cost')::numeric,0),2);
    if final_unit_cost<=0 then raise exception 'Final landed unit cost must be greater than zero for %',coalesce(source_item.item_code,source_item.description); end if;
    goods_total:=goods_total+round(source_item.qty*source_item.unit_cost,2);
    final_total:=final_total+round(source_item.qty*final_unit_cost,2);
  end loop;

  goods_total:=round(coalesce(nullif(transit_doc.source_goods_cost_amount,0),nullif(transit_doc.total_amount,0),goods_total),2);
  final_total:=round(final_total,2);
  if final_total+0.004<goods_total then
    raise exception 'Final landed total (%) cannot be below the goods cost already recorded (%)',final_total,goods_total;
  end if;
  shipping_cost:=round(greatest(final_total-goods_total,0),2);

  if shipping_cost>0.004 then
    payment_method_id:=nullif(p_payment->>'payment_method_id','')::uuid;
    select * into payment_method from public.payment_methods where id=payment_method_id and is_active for share;
    if not found or not coalesce(payment_method.is_paid_method,true) then
      raise exception 'Select an active paid payment account for the shipping/arrival cost';
    end if;
    perform public.validate_cheque_payments_v56(jsonb_build_array(p_payment||jsonb_build_object('amount',shipping_cost,'direction','out')));
  end if;

  purchase_doc_no:=public.next_document_no('purchase');
  paid_total:=round(coalesce(transit_doc.paid_amount,0)+shipping_cost,2);
  balance_total:=round(final_total-paid_total,2);
  insert into public.documents(
    id,document_no,external_document_no,document_type,status,supplier_id,customer_id,
    total_amount,paid_amount,balance_amount,currency,payment_method_id,document_date,
    shipping_method,linked_document_id,source_goods_cost_amount,landed_cost_amount,notes
  ) values (
    purchase_doc_id,purchase_doc_no,transit_doc.external_document_no,'purchase','completed',transit_doc.supplier_id,transit_doc.customer_id,
    final_total,paid_total,balance_total,coalesce(transit_doc.currency,'LKR'),coalesce(payment_method_id,transit_doc.payment_method_id),
    coalesce(p_arrival_date,current_date)::timestamptz,transit_doc.shipping_method,transit_doc.id,goods_total,shipping_cost,
    concat_ws(E'\n','Arrived from '||transit_doc.document_no||'. Goods cost was recorded on the transit document; only the landed-cost increase was paid here.',nullif(trim(coalesce(p_notes,'')),''))
  );

  for source_item in select * from public.document_items where document_id=p_transit_doc_id order by created_at,id loop
    select x.value into arrival_item from jsonb_array_elements(p_arrival_items) x
    where nullif(x.value->>'source_item_id','')::uuid=source_item.id;
    final_unit_cost:=round((arrival_item->>'final_unit_cost')::numeric,2);

    insert into public.stock_balances(product_id) values(source_item.product_id) on conflict(product_id) do nothing;
    perform 1 from public.stock_balances where product_id=source_item.product_id for update;
    if (select coalesce(in_transit_qty,0) from public.stock_balances where product_id=source_item.product_id)<source_item.qty then
      raise exception 'In-transit quantity is no longer sufficient for %',coalesce(source_item.item_code,source_item.description);
    end if;
    update public.stock_balances set in_transit_qty=in_transit_qty-source_item.qty,updated_at=now() where product_id=source_item.product_id;

    insert into public.document_items(
      document_id,product_id,item_code,description,qty,unit_price,unit_cost,discount_type,discount_value,line_total,line_kind
    ) values (
      purchase_doc_id,source_item.product_id,source_item.item_code,source_item.description,source_item.qty,final_unit_cost,final_unit_cost,
      'none',0,round(source_item.qty*final_unit_cost,2),'standard'
    );
    perform public.apply_stock_receiving(
      source_item.product_id,
      source_item.qty,
      final_unit_cost,
      purchase_doc_id,
      'Final landed receipt from '||transit_doc.document_no,
      'receive_from_transit'
    );
  end loop;

  if shipping_cost>0.004 then
    insert into public.cashflow_entries(document_id,entry_type,account_name,payment_method_id,amount,description,created_by)
    values(purchase_doc_id,'cash_out',payment_method.name,payment_method.id,shipping_cost,'Shipping / arrival cost for '||transit_doc.document_no,auth.uid());
    perform public.record_cheque_payments_v56(
      purchase_doc_id,
      jsonb_build_array(p_payment||jsonb_build_object('amount',shipping_cost,'direction','out')),
      'out'
    );
  end if;

  update public.documents set status='converted',linked_document_id=purchase_doc_id,updated_at=now() where id=transit_doc.id;
  perform public.sync_transit_arrival_accounting_v82(purchase_doc_id);

  return jsonb_build_object(
    'id',purchase_doc_id,'document_no',purchase_doc_no,'source_document_no',transit_doc.document_no,
    'goods_cost',goods_total,'shipping_cost',shipping_cost,'final_landed_total',final_total
  );
end;
$$;

-- Permit a deliberately marked component credit to be a negative stock line
-- without pretending it came from an earlier invoice. Normal Return lines still
-- require and validate their original sold line exactly as before.
create or replace function public.save_pos_invoice_v36(p_header jsonb,p_items jsonb,p_payments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  item jsonb; source_row record; prior_qty numeric; requested_qty numeric; gross numeric:=0;
  line_gross numeric; line_discount numeric; line_total numeric; cart_discount numeric:=0; final_total numeric;
  result jsonb; doc_id uuid; doc_no text; saved_item_id uuid; item_index integer:=0; product_row record;
  cust_id uuid:=nullif(p_header->>'customer_id','')::uuid; component_credit boolean;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  for item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    if coalesce((item->>'qty')::numeric,0)<0 then
      component_credit:=coalesce(item->>'line_kind','standard')='component_credit';
      if component_credit then
        if not public.has_pos_permission_v38('process_returns') then raise exception 'Return permission required for a Swap'; end if;
        if nullif(item->>'source_document_item_id','') is not null then raise exception 'A Swap cannot be linked to an earlier invoice'; end if;
        if not exists(select 1 from public.products where id=nullif(item->>'product_id','')::uuid and coalesce(track_inventory,true) and coalesce(inventory_ownership,'owned')='owned') then
          raise exception 'Swap requires a normal shop-owned inventory product';
        end if;
      else
        if nullif(item->>'source_document_item_id','') is null then raise exception 'Use Return and select the original invoice before adding a negative item'; end if;
        select di.id,di.qty,d.document_type into source_row from public.document_items di join public.documents d on d.id=di.document_id
        where di.id=(item->>'source_document_item_id')::uuid for update of di;
        if not found or source_row.qty<=0 or source_row.document_type<>'invoice' then raise exception 'Original sold invoice item was not found'; end if;
        select coalesce(sum(abs(qty)),0) into prior_qty from public.document_items where source_document_item_id=source_row.id and qty<0;
        select coalesce(sum(abs((x.value->>'qty')::numeric)),0) into requested_qty from jsonb_array_elements(p_items) x
        where nullif(x.value->>'source_document_item_id','')::uuid=source_row.id and (x.value->>'qty')::numeric<0;
        if prior_qty+requested_qty>source_row.qty then raise exception 'Return quantity exceeds the quantity remaining on the original invoice'; end if;
      end if;
    end if;
    line_gross:=round(coalesce((item->>'qty')::numeric,0)*coalesce((item->>'unit_price')::numeric,0),2);
    if coalesce(item->>'discount_type','none')='percent' then line_discount:=round(abs(line_gross)*coalesce((item->>'discount_value')::numeric,0)/100,2);
    elsif coalesce(item->>'discount_type','none')='amount' then line_discount:=coalesce((item->>'discount_value')::numeric,0); else line_discount:=0; end if;
    gross:=gross+case when line_gross<0 then line_gross+line_discount else line_gross-line_discount end;
  end loop;
  if coalesce(p_header->>'cart_discount_type','amount')='percent' then cart_discount:=round(abs(gross)*coalesce((p_header->>'cart_discount_value')::numeric,0)/100,2);
  else cart_discount:=coalesce((p_header->>'cart_discount_value')::numeric,0); end if;
  final_total:=round(case when gross<0 then gross+abs(cart_discount) else gross-cart_discount end,2);

  if final_total<>0 then
    result:=public.save_pos_invoice_v35(p_header,p_items,p_payments); doc_id:=(result->>'id')::uuid;
  else
    if jsonb_array_length(coalesce(p_payments,'[]'::jsonb))>0 then raise exception 'A zero-value exchange cannot contain payment lines'; end if;
    if not exists(select 1 from jsonb_array_elements(p_items) x where (x.value->>'qty')::numeric<0)
       or not exists(select 1 from jsonb_array_elements(p_items) x where (x.value->>'qty')::numeric>0) then
      raise exception 'A zero-value document must contain both a returned item and a replacement item';
    end if;
    doc_no:=coalesce(nullif(p_header->>'document_no',''),public.next_document_no('invoice'));
    insert into public.documents(document_no,document_type,status,customer_id,total_amount,paid_amount,balance_amount,currency,document_date,notes)
    values(doc_no,'invoice','completed',cust_id,0,0,0,'LKR',now(),nullif(p_header->>'notes','')) returning id into doc_id;
    for item in select value from jsonb_array_elements(p_items) loop
      insert into public.stock_balances(product_id) values((item->>'product_id')::uuid) on conflict(product_id) do nothing;
      select p.id,p.avg_cost,s.sellable_qty,s.reserved_qty into product_row from public.products p join public.stock_balances s on s.product_id=p.id
      where p.id=(item->>'product_id')::uuid for update of s;
      if not found then raise exception 'Product not found while saving exchange'; end if;
      line_gross:=round((item->>'qty')::numeric*coalesce((item->>'unit_price')::numeric,0),2);
      if coalesce(item->>'discount_type','none')='percent' then line_discount:=round(abs(line_gross)*coalesce((item->>'discount_value')::numeric,0)/100,2);
      elsif coalesce(item->>'discount_type','none')='amount' then line_discount:=coalesce((item->>'discount_value')::numeric,0); else line_discount:=0; end if;
      line_total:=case when line_gross<0 then line_gross+line_discount else line_gross-line_discount end;
      insert into public.document_items(document_id,product_id,item_code,description,qty,unit_price,unit_cost,discount_type,discount_value,line_total,return_condition,source_document_item_id,return_reason,line_kind)
      values(doc_id,(item->>'product_id')::uuid,item->>'item_code',item->>'description',(item->>'qty')::numeric,coalesce((item->>'unit_price')::numeric,0),coalesce((item->>'unit_cost')::numeric,product_row.avg_cost,0),coalesce(item->>'discount_type','none'),coalesce((item->>'discount_value')::numeric,0),line_total,case when (item->>'qty')::numeric<0 then coalesce(item->>'return_condition','sellable') end,nullif(item->>'source_document_item_id','')::uuid,nullif(item->>'return_reason',''),coalesce(nullif(item->>'line_kind',''),'standard'));
      if (item->>'qty')::numeric>0 then
        if product_row.sellable_qty-product_row.reserved_qty<(item->>'qty')::numeric then raise exception 'Not enough available stock for exchange item %',item->>'item_code'; end if;
        update public.stock_balances set sellable_qty=sellable_qty-(item->>'qty')::numeric,updated_at=now() where product_id=(item->>'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item->>'product_id')::uuid,doc_id,'sale',-1*(item->>'qty')::numeric,coalesce((item->>'unit_cost')::numeric,product_row.avg_cost,0),'POS exchange replacement');
      elsif coalesce(item->>'return_condition','sellable')='warranty_damaged' then
        update public.stock_balances set damaged_qty=damaged_qty+abs((item->>'qty')::numeric),updated_at=now() where product_id=(item->>'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item->>'product_id')::uuid,doc_id,'return_damaged',abs((item->>'qty')::numeric),coalesce((item->>'unit_cost')::numeric,product_row.avg_cost,0),'Damaged item received in exchange');
      else
        update public.stock_balances set sellable_qty=sellable_qty+abs((item->>'qty')::numeric),updated_at=now() where product_id=(item->>'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item->>'product_id')::uuid,doc_id,'return_sellable',abs((item->>'qty')::numeric),coalesce((item->>'unit_cost')::numeric,product_row.avg_cost,0),case when coalesce(item->>'line_kind','standard')='component_credit' then 'Component removed during upgrade swap' else 'Sellable item received in exchange' end);
      end if;
    end loop;
    result:=jsonb_build_object('id',doc_id,'document_no',doc_no,'total_amount',0,'paid_amount',0,'balance_amount',0,'resulting_outstanding',null,'balance_applied',0,'document_balance',0);
  end if;

  item_index:=0;
  for item in select value from jsonb_array_elements(p_items) loop
    item_index:=item_index+1;
    select id into saved_item_id from public.document_items where document_id=doc_id order by ctid offset (item_index - 1) limit 1;
    update public.document_items set
      source_document_item_id=nullif(item->>'source_document_item_id','')::uuid,
      return_reason=nullif(item->>'return_reason',''),
      line_kind=coalesce(nullif(item->>'line_kind',''),'standard')
    where id=saved_item_id;
  end loop;
  return result;
end;
$$;

revoke all on function public.save_stock_in_transit_v82(jsonb,jsonb,jsonb,numeric) from public;
revoke all on function public.replace_stock_in_transit_v82(uuid,jsonb,jsonb,jsonb,numeric) from public;
revoke all on function public.receive_stock_in_transit_v82(uuid,jsonb,jsonb,date,text) from public;
revoke all on function public.sync_transit_arrival_accounting_v82(uuid) from public;
revoke all on function public.save_pos_invoice_v36(jsonb,jsonb,jsonb) from public;
grant execute on function public.save_stock_in_transit_v82(jsonb,jsonb,jsonb,numeric) to authenticated;
grant execute on function public.replace_stock_in_transit_v82(uuid,jsonb,jsonb,jsonb,numeric) to authenticated;
grant execute on function public.receive_stock_in_transit_v82(uuid,jsonb,jsonb,date,text) to authenticated;
grant execute on function public.save_pos_invoice_v36(jsonb,jsonb,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
