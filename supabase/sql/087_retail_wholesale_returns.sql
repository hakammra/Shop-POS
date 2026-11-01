-- Wholesale Catalog customer returns: credit Wholesale at the original
-- inter-business transfer price and send the physical unit back to Wholesale.
-- Apply after 086; deploy matching Retail and Wholesale bridge functions.
begin;

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check check (document_type in (
  'invoice','unconfirmed_sale','quotation','reservation','purchase','purchase_return',
  'stock_in_transit','stock_receiving','refund','trade_in','stock_adjustment',
  'stock_condition_transfer','consignment_intake','consignment_return','job',
  'customer_payment','supplier_payment','expense','other_income','account_transfer',
  'online_order','cod_order'
));
alter table public.retail_wholesale_transfers
  add column if not exists retail_purchase_return_document_id uuid
    references public.documents(id) on delete set null;

create or replace function public.prepare_retail_wholesale_exchange_v87(p_transfer_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  existing public.retail_wholesale_transfers%rowtype;
  source_line public.document_items%rowtype;
  source_doc public.documents%rowtype;
  source_transfer public.retail_wholesale_transfers%rowtype;
  line jsonb; link_row public.retail_wholesale_product_links%rowtype;
  fingerprint text; sale_reference text; normalized_payload jsonb;
  request_items jsonb; return_items jsonb:='[]'::jsonb;
  quantity numeric; prior_quantity numeric; pending_quantity numeric;
  condition_value text; operator_id uuid;
begin
  if p_transfer_id is null then raise exception 'A stable transfer ID is required'; end if;
  operator_id:=public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  if jsonb_array_length(coalesce(p_payload->'items','[]'::jsonb))=0 then raise exception 'Add at least one item'; end if;
  fingerprint:=encode(extensions.digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'::text),'hex');

  select coalesce(jsonb_agg(jsonb_build_object('product_id',q.wholesale_product_id,'qty',q.qty)
    order by q.wholesale_product_id),'[]'::jsonb)
  into request_items from (
    select l.wholesale_product_id,sum((item->>'qty')::numeric) qty
    from jsonb_array_elements(p_payload->'items') item
    join public.retail_wholesale_product_links l on l.retail_product_id=(item->>'product_id')::uuid
    where coalesce((item->>'qty')::numeric,0)>0
    group by l.wholesale_product_id
  ) q;

  for line in select value from jsonb_array_elements(p_payload->'items') loop
    if coalesce((line->>'qty')::numeric,0)>=0 then continue; end if;
    select * into link_row from public.retail_wholesale_product_links
    where retail_product_id=nullif(line->>'product_id','')::uuid;
    if not found then continue; end if;
    if not public.has_pos_permission_v38('process_returns') then raise exception 'Return permission required'; end if;
    if nullif(line->>'source_document_item_id','') is null then
      raise exception 'A Wholesale Catalog return must be linked to its original Retail invoice';
    end if;
    select * into source_line from public.document_items
    where id=(line->>'source_document_item_id')::uuid for update;
    if not found or source_line.product_id is distinct from link_row.retail_product_id or source_line.qty<=0 then
      raise exception 'The original Retail Wholesale item was not found';
    end if;
    select * into source_doc from public.documents where id=source_line.document_id;
    select * into source_transfer from public.retail_wholesale_transfers
    where retail_invoice_document_id=source_doc.id and status='retail_posted';
    if source_doc.document_type<>'invoice' or source_transfer.id is null
       or source_transfer.wholesale_document_id is null then
      raise exception 'This Wholesale Catalog item has no completed original Wholesale transfer';
    end if;
    if source_doc.customer_id is distinct from nullif(p_payload->'header'->>'customer_id','')::uuid then
      raise exception 'The returned item belongs to a different Retail customer';
    end if;
    select count(*) into prior_quantity from jsonb_array_elements(p_payload->'items') x
    where nullif(x.value->>'source_document_item_id','')::uuid=source_line.id
      and coalesce((x.value->>'qty')::numeric,0)<0;
    if prior_quantity<>1 then raise exception 'Add an original Wholesale item only once per return'; end if;
    quantity:=abs((line->>'qty')::numeric);
    condition_value:=coalesce(nullif(line->>'return_condition',''),'sellable');
    if condition_value not in ('sellable','warranty_damaged') then raise exception 'Invalid Wholesale return condition'; end if;
    select coalesce(sum(abs(di.qty)),0) into prior_quantity
    from public.document_items di
    join public.documents returned_doc on returned_doc.id=di.document_id
    where di.source_document_item_id=source_line.id and di.qty<0
      and returned_doc.document_type in ('invoice','refund');
    select coalesce(sum(abs((pending_line.value->>'qty')::numeric)),0) into pending_quantity
    from public.retail_wholesale_transfers pending
    cross join lateral jsonb_array_elements(coalesce(pending.wholesale_request->'returns','[]'::jsonb)) pending_line
    where pending.id<>p_transfer_id
      and pending.status in ('pending','failed','wholesale_posted')
      and pending_line.value->>'source_retail_item_id'=source_line.id::text;
    if prior_quantity+pending_quantity+quantity>source_line.qty then
      raise exception 'Wholesale return quantity exceeds the original sold quantity';
    end if;
    return_items:=return_items||jsonb_build_array(jsonb_build_object(
      'source_retail_item_id',source_line.id,
      'original_retail_sale_reference',source_doc.document_no,
      'original_wholesale_document_id',source_transfer.wholesale_document_id,
      'wholesale_product_id',link_row.wholesale_product_id,
      'retail_product_id',link_row.retail_product_id,
      'qty',quantity,'condition',condition_value
    ));
  end loop;

  if jsonb_array_length(request_items)=0 and jsonb_array_length(return_items)=0 then
    raise exception 'This bill has no Wholesale Catalog items';
  end if;
  if jsonb_array_length(return_items)>0
     and not public.has_pos_permission_v38('view_documents') then
    raise exception 'Document viewing permission is required to complete a linked Wholesale return';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_payload->'items') item
    join public.retail_wholesale_product_links l on l.retail_product_id=(item->>'product_id')::uuid
    where coalesce((item->>'qty')::numeric,0)>0 and not l.is_enabled
  ) then raise exception 'One or more Wholesale Catalog items are no longer available'; end if;

  select * into existing from public.retail_wholesale_transfers where id=p_transfer_id for update;
  if found then
    if existing.request_fingerprint<>fingerprint then
      if existing.wholesale_response is null then
        raise exception 'This pending Wholesale transfer belongs to an earlier version of the bill. Retry it unchanged';
      end if;
      if coalesce(existing.wholesale_request->'items','[]'::jsonb)<>request_items
         or coalesce(existing.wholesale_request->'returns','[]'::jsonb)<>return_items then
        raise exception 'Wholesale already posted this transfer. Products, quantities and return conditions cannot change';
      end if;
      normalized_payload:=p_payload||jsonb_build_object('header',p_payload->'header'||jsonb_build_object('document_no',existing.retail_sale_reference));
      update public.retail_wholesale_transfers
      set request_fingerprint=fingerprint,request_payload=normalized_payload,last_error=null,updated_at=now()
      where id=existing.id returning * into existing;
    end if;
    return to_jsonb(existing);
  end if;

  sale_reference:=coalesce(nullif(trim(p_payload->'header'->>'document_no'),''),public.next_document_no('invoice'));
  normalized_payload:=p_payload||jsonb_build_object('header',p_payload->'header'||jsonb_build_object('document_no',sale_reference));
  insert into public.retail_wholesale_transfers(
    id,idempotency_key,request_fingerprint,status,next_step,retail_sale_reference,
    request_payload,wholesale_request,requested_by_staff_id
  ) values (
    p_transfer_id,'retail-transfer:'||p_transfer_id::text,fingerprint,'pending','wholesale_post',sale_reference,
    normalized_payload,jsonb_build_object('action','post_sale',
      'idempotency_key','retail-transfer:'||p_transfer_id::text,
      'retail_sale_reference',sale_reference,
      'sale_date',coalesce(nullif(p_payload->'header'->>'document_date',''),current_date::text),
      'items',request_items,'returns',return_items),operator_id
  ) returning * into existing;
  return to_jsonb(existing);
end;
$$;

create or replace function public.post_retail_wholesale_exchange_v87(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  transfer public.retail_wholesale_transfers%rowtype;
  base_result jsonb; invoice_result jsonb; purchase_result jsonb;
  requested jsonb; returned jsonb; source_item public.document_items%rowtype;
  original_purchase public.documents%rowtype; stock_row public.stock_balances%rowtype;
  product_row public.products%rowtype; return_doc_id uuid; return_doc_no text;
  profile_id uuid; supplier_id_value uuid; amount_value numeric; qty_value numeric;
  total_value numeric:=0; bucket text; entry_id uuid; saved_item_id uuid;
begin
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('pos_sales') then raise exception 'POS sales permission required'; end if;
  select * into transfer from public.retail_wholesale_transfers where id=p_transfer_id for update;
  if not found then raise exception 'Wholesale transfer not found'; end if;
  if transfer.status='retail_posted' then
    return jsonb_build_object('transfer_id',transfer.id,
      'invoice',jsonb_build_object('id',transfer.retail_invoice_document_id,'document_no',transfer.retail_sale_reference),
      'purchase',jsonb_build_object('id',transfer.retail_purchase_document_id),
      'purchase_return',jsonb_build_object('id',transfer.retail_purchase_return_document_id),
      'wholesale',transfer.wholesale_response,'already_posted',true);
  end if;
  if transfer.wholesale_response is null or coalesce((transfer.wholesale_response->>'success')::boolean,false)=false then
    raise exception 'Wholesale has not posted this transfer yet';
  end if;
  if jsonb_array_length(coalesce(transfer.wholesale_request->'items','[]'::jsonb))>0 then
    base_result:=public.post_retail_wholesale_transfer_v76(p_transfer_id);
    invoice_result:=base_result->'invoice';
    purchase_result:=base_result->'purchase';
  else
    perform set_config('shop_pos.retail_wholesale_transfer_id',transfer.id::text,true);
    perform set_config('shop_pos.retail_wholesale_operator_id',transfer.requested_by_staff_id::text,true);
    invoice_result:=public.save_pos_invoice_v74(
      transfer.request_payload->'header',transfer.request_payload->'items',transfer.request_payload->'payments');
    update public.retail_wholesale_transfers
    set status='retail_posted',next_step='complete',retail_invoice_document_id=(invoice_result->>'id')::uuid,
        last_error=null,retail_posted_at=now(),updated_at=now()
    where id=transfer.id;
  end if;

  if jsonb_array_length(coalesce(transfer.wholesale_request->'returns','[]'::jsonb))=0 then
    return coalesce(base_result,jsonb_build_object('transfer_id',transfer.id,'invoice',invoice_result,'purchase',purchase_result,'wholesale',transfer.wholesale_response));
  end if;
  if jsonb_array_length(coalesce(transfer.wholesale_request->'returns','[]'::jsonb))
     <> jsonb_array_length(coalesce(transfer.wholesale_response->'returns','[]'::jsonb)) then
    raise exception 'Wholesale return response is incomplete';
  end if;

  for requested in select value from jsonb_array_elements(transfer.wholesale_request->'returns') loop
    select value into returned from jsonb_array_elements(transfer.wholesale_response->'returns')
    where value->>'source_retail_item_id'=requested->>'source_retail_item_id' limit 1;
    if returned is null
       or coalesce((returned->>'qty')::numeric,0)<>(requested->>'qty')::numeric
       or returned->>'condition'<>requested->>'condition'
       or returned->>'wholesale_product_id'<>requested->>'wholesale_product_id'
       or nullif(returned->>'credit_document_id','') is null then
      raise exception 'Wholesale return does not match the Retail source item';
    end if;
    select * into source_item from public.document_items
    where id=(requested->>'source_retail_item_id')::uuid;
    select * into original_purchase from public.documents
    where id=(select retail_purchase_document_id from public.retail_wholesale_transfers
              where wholesale_document_id=(requested->>'original_wholesale_document_id')::uuid);
    if not found or original_purchase.document_type<>'purchase' or source_item.id is null then
      raise exception 'Original Retail JIT purchase for returned item was not found';
    end if;
    if profile_id is null then
      profile_id:=original_purchase.customer_id;
      supplier_id_value:=original_purchase.supplier_id;
    elsif profile_id is distinct from original_purchase.customer_id
       or supplier_id_value is distinct from original_purchase.supplier_id then
      raise exception 'Wholesale returns in one bill must use the same inter-business supplier';
    end if;
    if profile_id is null or supplier_id_value is null then raise exception 'Original Retail JIT supplier is incomplete'; end if;
    amount_value:=coalesce((returned->>'amount')::numeric,0);
    qty_value:=(requested->>'qty')::numeric;
    if qty_value<=0 or amount_value<=0
       or abs(amount_value-round(qty_value*coalesce((returned->>'unit_price')::numeric,0),2))>0.01
       or abs(coalesce(source_item.unit_cost,0)-coalesce((returned->>'unit_price')::numeric,0))>0.01 then
      raise exception 'Original Retail cost and Wholesale return credit do not match';
    end if;
    total_value:=total_value+amount_value;
  end loop;

  return_doc_id:=gen_random_uuid();
  return_doc_no:='PR-'||transfer.retail_sale_reference;
  insert into public.documents(
    id,document_no,document_type,status,customer_id,supplier_id,linked_document_id,
    total_amount,paid_amount,balance_amount,currency,document_date,notes,created_by,
    party_balance_applied,party_balance_delta,party_balance_customer_id
  ) values (
    return_doc_id,return_doc_no,'purchase_return','completed',profile_id,supplier_id_value,
    (invoice_result->>'id')::uuid,-total_value,0,-total_value,'LKR',
    coalesce(nullif(transfer.request_payload->'header'->>'document_date','')::date,current_date),
    'Automatic Wholesale purchase return for Retail exchange '||transfer.retail_sale_reference,
    auth.uid(),true,total_value,profile_id
  );

  for requested in select value from jsonb_array_elements(transfer.wholesale_request->'returns') loop
    select value into returned from jsonb_array_elements(transfer.wholesale_response->'returns')
    where value->>'source_retail_item_id'=requested->>'source_retail_item_id' limit 1;
    qty_value:=(requested->>'qty')::numeric;
    amount_value:=(returned->>'amount')::numeric;
    bucket:=case when requested->>'condition'='warranty_damaged' then 'damaged' else 'sellable' end;
    select * into product_row from public.products where id=(requested->>'retail_product_id')::uuid for update;
    select * into stock_row from public.stock_balances where product_id=product_row.id for update;
    if product_row.id is null or stock_row.product_id is null then raise exception 'Retail returned product stock was not found'; end if;
    if (bucket='sellable' and stock_row.sellable_qty-stock_row.reserved_qty<qty_value)
       or (bucket='damaged' and stock_row.damaged_qty<qty_value) then
      raise exception 'Returned Wholesale item is no longer available in Retail % stock',bucket;
    end if;
    insert into public.document_items(
      document_id,product_id,item_code,description,qty,unit_price,unit_cost,line_total,
      stock_from_bucket,return_condition,source_document_item_id
    ) values (
      return_doc_id,product_row.id,product_row.item_code,product_row.name,-qty_value,0,
      (returned->>'unit_price')::numeric,-amount_value,bucket,
      requested->>'condition',(requested->>'source_retail_item_id')::uuid
    ) returning id into saved_item_id;
    update public.stock_balances
    set sellable_qty=sellable_qty-case when bucket='sellable' then qty_value else 0 end,
        damaged_qty=damaged_qty-case when bucket='damaged' then qty_value else 0 end,
        updated_at=now()
    where product_id=product_row.id;
    insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes,created_by)
    values(product_row.id,return_doc_id,'stock_adjustment',-qty_value,
      (returned->>'unit_price')::numeric,
      'Returned to Wholesale as '||case when bucket='damaged' then 'warranty/damaged' else 'sellable' end||
      ' on credit note '||(returned->>'credit_document_no'),auth.uid());
    if bucket='sellable' then
      update public.retail_wholesale_product_links
      set last_wholesale_available_qty=last_wholesale_available_qty+qty_value,
          last_synced_at=now(),updated_at=now()
      where retail_product_id=product_row.id;
    end if;
  end loop;

  perform public.apply_customer_outstanding_delta(profile_id,total_value);
  insert into public.accounting_journal_entries(
    source_type,source_key,source_document_id,entry_date,reference_no,description,is_manual
  ) values (
    'wholesale_return',return_doc_id::text,return_doc_id,
    coalesce(nullif(transfer.request_payload->'header'->>'document_date','')::date,current_date),
    return_doc_no,'Wholesale purchase return / supplier credit',false
  ) returning id into entry_id;
  perform public.add_accounting_line_v42(entry_id,public.accounting_account_id_v42('accounts_payable'),total_value,0,'Reduce Wholesale supplier payable');
  for requested in select value from jsonb_array_elements(transfer.wholesale_request->'returns') loop
    select value into returned from jsonb_array_elements(transfer.wholesale_response->'returns')
    where value->>'source_retail_item_id'=requested->>'source_retail_item_id' limit 1;
    perform public.add_accounting_line_v42(
      entry_id,
      public.accounting_account_id_v42(case when requested->>'condition'='warranty_damaged' then 'damaged_inventory' else 'inventory' end),
      0,(returned->>'amount')::numeric,'Stock returned to Wholesale'
    );
  end loop;
  update public.retail_wholesale_transfers
  set retail_purchase_return_document_id=return_doc_id,updated_at=now()
  where id=transfer.id;
  return jsonb_build_object('transfer_id',transfer.id,'invoice',invoice_result,'purchase',purchase_result,
    'purchase_return',jsonb_build_object('id',return_doc_id,'document_no',return_doc_no,'total_amount',-total_value),
    'wholesale',transfer.wholesale_response,'already_posted',false);
end;
$$;

create or replace function public.guard_retail_wholesale_return_document_v87()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if current_setting('shop_pos.restore_mode',true)='on' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if old.document_type='purchase_return'
     or exists(select 1 from public.retail_wholesale_transfers t
       where t.retail_invoice_document_id=old.id
         and jsonb_array_length(coalesce(t.wholesale_request->'returns','[]'::jsonb))>0) then
    raise exception 'A linked Wholesale return cannot be edited or deleted independently; contact an administrator for a coordinated correction';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists guard_retail_wholesale_return_document_v87_trigger on public.documents;
create trigger guard_retail_wholesale_return_document_v87_trigger
before update or delete on public.documents for each row
execute function public.guard_retail_wholesale_return_document_v87();

create or replace function public.guard_retail_wholesale_return_item_v87()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if current_setting('shop_pos.restore_mode',true)='on' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if exists(select 1 from public.documents d where d.id=old.document_id
    and d.document_type='purchase_return')
    or exists(select 1 from public.retail_wholesale_transfers t
      where t.retail_invoice_document_id=old.document_id
        and jsonb_array_length(coalesce(t.wholesale_request->'returns','[]'::jsonb))>0) then
    raise exception 'A linked Wholesale return item cannot be edited or deleted independently';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists guard_retail_wholesale_return_item_v87_trigger on public.document_items;
create trigger guard_retail_wholesale_return_item_v87_trigger
before update or delete on public.document_items for each row
execute function public.guard_retail_wholesale_return_item_v87();

create or replace function public.guard_retail_wholesale_return_cancel_v87()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if jsonb_array_length(coalesce(old.wholesale_request->'returns','[]'::jsonb))>0
     and new.status in ('cancel_pending','wholesale_cancelled','cancelled') then
    raise exception 'Wholesale return transfers cannot be cancelled independently. Retry the pending transfer or coordinate reversal with both stores';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_retail_wholesale_return_cancel_v87_trigger on public.retail_wholesale_transfers;
create trigger guard_retail_wholesale_return_cancel_v87_trigger
before update of status on public.retail_wholesale_transfers for each row
execute function public.guard_retail_wholesale_return_cancel_v87();

revoke all on function public.prepare_retail_wholesale_exchange_v87(uuid,jsonb) from public;
revoke all on function public.post_retail_wholesale_exchange_v87(uuid) from public;
grant execute on function public.prepare_retail_wholesale_exchange_v87(uuid,jsonb) to authenticated;
grant execute on function public.post_retail_wholesale_exchange_v87(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
