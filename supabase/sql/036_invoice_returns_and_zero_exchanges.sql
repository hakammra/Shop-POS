-- v36: Invoice-linked POS returns and zero-value exchanges.
-- Run once after 035_pos_credit_choice.sql.

alter table public.document_items add column if not exists source_document_item_id uuid references public.document_items(id) on delete set null;
alter table public.document_items add column if not exists return_reason text;
create index if not exists document_items_source_return_idx on public.document_items(source_document_item_id) where source_document_item_id is not null;

create or replace function public.save_pos_invoice_v36(p_header jsonb, p_items jsonb, p_payments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  source_row record;
  prior_qty numeric;
  requested_qty numeric;
  gross numeric := 0;
  line_gross numeric;
  line_discount numeric;
  line_total numeric;
  cart_discount numeric := 0;
  final_total numeric;
  result jsonb;
  doc_id uuid;
  doc_no text;
  saved_item_id uuid;
  item_index integer := 0;
  product_row record;
  cust_id uuid := nullif(p_header ->> 'customer_id', '')::uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((item ->> 'qty')::numeric, 0) < 0 then
      if nullif(item ->> 'source_document_item_id', '') is null then raise exception 'Use Return and select the original invoice before adding a negative item'; end if;
      select di.id, di.qty, d.document_type into source_row
      from public.document_items di join public.documents d on d.id = di.document_id
      where di.id = (item ->> 'source_document_item_id')::uuid for update of di;
      if not found or source_row.qty <= 0 or source_row.document_type <> 'invoice' then raise exception 'Original sold invoice item was not found'; end if;
      select coalesce(sum(abs(qty)), 0) into prior_qty from public.document_items where source_document_item_id = source_row.id and qty < 0;
      select coalesce(sum(abs((x.value ->> 'qty')::numeric)), 0) into requested_qty
      from jsonb_array_elements(p_items) x
      where nullif(x.value ->> 'source_document_item_id', '')::uuid = source_row.id and (x.value ->> 'qty')::numeric < 0;
      if prior_qty + requested_qty > source_row.qty then raise exception 'Return quantity exceeds the quantity remaining on the original invoice'; end if;
    end if;
    line_gross := round(coalesce((item ->> 'qty')::numeric, 0) * coalesce((item ->> 'unit_price')::numeric, 0), 2);
    if coalesce(item ->> 'discount_type', 'none') = 'percent' then line_discount := round(abs(line_gross) * coalesce((item ->> 'discount_value')::numeric, 0) / 100, 2);
    elsif coalesce(item ->> 'discount_type', 'none') = 'amount' then line_discount := coalesce((item ->> 'discount_value')::numeric, 0);
    else line_discount := 0; end if;
    gross := gross + case when line_gross < 0 then line_gross + line_discount else line_gross - line_discount end;
  end loop;

  if coalesce(p_header ->> 'cart_discount_type', 'amount') = 'percent' then cart_discount := round(abs(gross) * coalesce((p_header ->> 'cart_discount_value')::numeric, 0) / 100, 2);
  else cart_discount := coalesce((p_header ->> 'cart_discount_value')::numeric, 0); end if;
  final_total := round(case when gross < 0 then gross + abs(cart_discount) else gross - cart_discount end, 2);

  if final_total <> 0 then
    result := public.save_pos_invoice_v35(p_header, p_items, p_payments);
    doc_id := (result ->> 'id')::uuid;
  else
    if jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) > 0 then raise exception 'A zero-value exchange cannot contain payment lines'; end if;
    if not exists (select 1 from jsonb_array_elements(p_items) x where (x.value ->> 'qty')::numeric < 0)
       or not exists (select 1 from jsonb_array_elements(p_items) x where (x.value ->> 'qty')::numeric > 0) then
      raise exception 'A zero-value document must contain both a returned item and a replacement item';
    end if;
    doc_no := coalesce(nullif(p_header ->> 'document_no', ''), public.next_document_no('invoice'));
    insert into public.documents(document_no, document_type, status, customer_id, total_amount, paid_amount, balance_amount, currency, document_date, notes)
    values(doc_no, 'invoice', 'completed', cust_id, 0, 0, 0, 'LKR', now(), nullif(p_header ->> 'notes', '')) returning id into doc_id;

    for item in select value from jsonb_array_elements(p_items) loop
      insert into public.stock_balances(product_id) values((item ->> 'product_id')::uuid) on conflict(product_id) do nothing;
      select p.id, p.avg_cost, s.sellable_qty, s.reserved_qty into product_row
      from public.products p join public.stock_balances s on s.product_id=p.id where p.id=(item ->> 'product_id')::uuid for update of s;
      if not found then raise exception 'Product not found while saving exchange'; end if;
      line_gross := round((item ->> 'qty')::numeric * coalesce((item ->> 'unit_price')::numeric,0),2);
      if coalesce(item ->> 'discount_type','none')='percent' then line_discount:=round(abs(line_gross)*coalesce((item ->> 'discount_value')::numeric,0)/100,2);
      elsif coalesce(item ->> 'discount_type','none')='amount' then line_discount:=coalesce((item ->> 'discount_value')::numeric,0); else line_discount:=0; end if;
      line_total:=case when line_gross<0 then line_gross+line_discount else line_gross-line_discount end;
      insert into public.document_items(document_id,product_id,item_code,description,qty,unit_price,unit_cost,discount_type,discount_value,line_total,return_condition,source_document_item_id,return_reason)
      values(doc_id,(item ->> 'product_id')::uuid,item ->> 'item_code',item ->> 'description',(item ->> 'qty')::numeric,coalesce((item ->> 'unit_price')::numeric,0),coalesce((item ->> 'unit_cost')::numeric,product_row.avg_cost,0),coalesce(item ->> 'discount_type','none'),coalesce((item ->> 'discount_value')::numeric,0),line_total,case when (item ->> 'qty')::numeric<0 then coalesce(item ->> 'return_condition','sellable') end,nullif(item ->> 'source_document_item_id','')::uuid,nullif(item ->> 'return_reason',''));
      if (item ->> 'qty')::numeric > 0 then
        if product_row.sellable_qty-product_row.reserved_qty < (item ->> 'qty')::numeric then raise exception 'Not enough available stock for exchange item %', item ->> 'item_code'; end if;
        update public.stock_balances set sellable_qty=sellable_qty-(item ->> 'qty')::numeric,updated_at=now() where product_id=(item ->> 'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item ->> 'product_id')::uuid,doc_id,'sale',-1*(item ->> 'qty')::numeric,coalesce((item ->> 'unit_cost')::numeric,product_row.avg_cost,0),'POS exchange replacement');
      elsif coalesce(item ->> 'return_condition','sellable')='warranty_damaged' then
        update public.stock_balances set damaged_qty=damaged_qty+abs((item ->> 'qty')::numeric),updated_at=now() where product_id=(item ->> 'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item ->> 'product_id')::uuid,doc_id,'return_damaged',abs((item ->> 'qty')::numeric),coalesce((item ->> 'unit_cost')::numeric,product_row.avg_cost,0),'Damaged item received in exchange');
      else
        update public.stock_balances set sellable_qty=sellable_qty+abs((item ->> 'qty')::numeric),updated_at=now() where product_id=(item ->> 'product_id')::uuid;
        insert into public.stock_movements(product_id,document_id,movement_type,qty,unit_cost,notes) values((item ->> 'product_id')::uuid,doc_id,'return_sellable',abs((item ->> 'qty')::numeric),coalesce((item ->> 'unit_cost')::numeric,product_row.avg_cost,0),'Sellable item received in exchange');
      end if;
    end loop;
    result:=jsonb_build_object('id',doc_id,'document_no',doc_no,'total_amount',0,'paid_amount',0,'balance_amount',0,'resulting_outstanding',null,'balance_applied',0,'document_balance',0);
  end if;

  -- The older save function handles accounting and stock. Add the original-line
  -- audit link to each inserted row in the same payload order.
  item_index:=0;
  for item in select value from jsonb_array_elements(p_items) loop
    item_index:=item_index+1;
    select id into saved_item_id from public.document_items where document_id=doc_id order by ctid offset (item_index - 1) limit 1;
    update public.document_items set source_document_item_id=nullif(item ->> 'source_document_item_id','')::uuid, return_reason=nullif(item ->> 'return_reason','') where id=saved_item_id;
  end loop;
  return result;
end;
$$;

revoke all on function public.save_pos_invoice_v36(jsonb,jsonb,jsonb) from public;
grant execute on function public.save_pos_invoice_v36(jsonb,jsonb,jsonb) to authenticated;
notify pgrst, 'reload schema';
