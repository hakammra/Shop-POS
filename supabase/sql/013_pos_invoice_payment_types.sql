-- v13: POS invoice workflow, paid/unpaid payment types, and customer balances.
-- Run once after v12 SQL files.

alter table public.payment_methods
  add column if not exists is_paid_method boolean not null default true;

update public.payment_methods
set is_paid_method = false,
    affects_cashflow = false
where lower(name) in ('credit', 'store credit');

update public.payment_methods
set is_paid_method = true
where lower(name) in ('cash', 'card', 'bank', 'bank transfer', 'online payment');

-- Re-create default methods if a fresh database missed any.
insert into public.payment_methods (name, affects_cashflow, is_paid_method, is_active)
values
  ('Cash', true, true, true),
  ('Card', true, true, true),
  ('Bank', true, true, true),
  ('Credit', false, false, true),
  ('Store Credit', false, false, true)
on conflict (name) do update
set is_active = true,
    is_paid_method = excluded.is_paid_method,
    affects_cashflow = excluded.affects_cashflow;

create or replace function public.save_pos_invoice(
  p_header jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  doc_no text;
  cust_id uuid;
  pm_id uuid;
  pm record;
  item record;
  product_row record;
  gross numeric(12,2) := 0;
  line_gross numeric(12,2);
  line_discount numeric(12,2);
  line_total numeric(12,2);
  cart_discount numeric(12,2) := 0;
  final_total numeric(12,2) := 0;
  paid numeric(12,2) := 0;
  balance numeric(12,2) := 0;
  note_text text;
begin
  doc_no := nullif(p_header ->> 'document_no', '');
  if doc_no is null then
    doc_no := public.next_document_no('invoice');
  end if;

  cust_id := nullif(p_header ->> 'customer_id', '')::uuid;
  pm_id := nullif(p_header ->> 'payment_method_id', '')::uuid;

  if pm_id is null then
    raise exception 'Select a payment method before saving invoice';
  end if;

  select * into pm from public.payment_methods where id = pm_id;
  if not found then
    raise exception 'Payment method not found';
  end if;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_price numeric,
      unit_cost numeric,
      discount_type text,
      discount_value numeric,
      return_condition text
    )
  loop
    if item.product_id is null or coalesce(item.qty, 0) = 0 then
      raise exception 'Every invoice item must have a product and non-zero quantity';
    end if;
    line_gross := round(coalesce(item.qty, 0) * coalesce(item.unit_price, 0), 2);
    if coalesce(item.discount_type, 'none') = 'percent' then
      line_discount := round(abs(line_gross) * (coalesce(item.discount_value, 0) / 100), 2);
    elsif coalesce(item.discount_type, 'none') = 'amount' then
      line_discount := coalesce(item.discount_value, 0);
    else
      line_discount := 0;
    end if;
    if line_gross < 0 then
      line_total := line_gross + line_discount;
    else
      line_total := line_gross - line_discount;
    end if;
    gross := gross + line_total;
  end loop;

  if gross = 0 then
    raise exception 'Invoice total cannot be zero in this version';
  end if;

  if coalesce(p_header ->> 'cart_discount_type', 'amount') = 'percent' then
    cart_discount := round(abs(gross) * (coalesce(nullif(p_header ->> 'cart_discount_value', '')::numeric, 0) / 100), 2);
  else
    cart_discount := coalesce(nullif(p_header ->> 'cart_discount_value', '')::numeric, 0);
  end if;

  if gross < 0 then
    final_total := round(gross + abs(cart_discount), 2);
  else
    final_total := round(gross - cart_discount, 2);
  end if;

  if final_total = 0 then
    raise exception 'Invoice total cannot be zero in this version';
  end if;

  if (final_total < 0 or pm.is_paid_method = false) and cust_id is null then
    raise exception 'Customer is required for credit, store credit, or negative invoice totals';
  end if;

  if pm.is_paid_method then
    paid := abs(final_total);
    balance := 0;
  else
    paid := 0;
    if final_total > 0 then
      balance := final_total;
    else
      balance := 0;
    end if;
  end if;

  note_text := nullif(p_header ->> 'notes', '');
  if cart_discount <> 0 then
    note_text := concat(coalesce(note_text || E'\n', ''), 'Cart discount: ', cart_discount::text);
  end if;

  insert into public.documents (
    document_no,
    document_type,
    status,
    customer_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    payment_method_id,
    document_date,
    notes
  ) values (
    doc_no,
    'invoice',
    case when balance > 0 then 'unpaid' else 'completed' end,
    cust_id,
    final_total,
    paid,
    balance,
    'LKR',
    pm_id,
    now(),
    note_text
  ) returning id into doc_id;

  for item in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
      product_id uuid,
      item_code text,
      description text,
      qty numeric,
      unit_price numeric,
      unit_cost numeric,
      discount_type text,
      discount_value numeric,
      return_condition text
    )
  loop
    select p.id, p.avg_cost, p.selling_price, coalesce(s.sellable_qty, 0) as sellable_qty, coalesce(s.damaged_qty, 0) as damaged_qty
    into product_row
    from public.products p
    left join public.stock_balances s on s.product_id = p.id
    where p.id = item.product_id;

    if not found then
      raise exception 'Product not found while saving invoice';
    end if;

    insert into public.stock_balances (product_id)
    values (item.product_id)
    on conflict (product_id) do nothing;

    line_gross := round(coalesce(item.qty, 0) * coalesce(item.unit_price, 0), 2);
    if coalesce(item.discount_type, 'none') = 'percent' then
      line_discount := round(abs(line_gross) * (coalesce(item.discount_value, 0) / 100), 2);
    elsif coalesce(item.discount_type, 'none') = 'amount' then
      line_discount := coalesce(item.discount_value, 0);
    else
      line_discount := 0;
    end if;
    if line_gross < 0 then
      line_total := line_gross + line_discount;
    else
      line_total := line_gross - line_discount;
    end if;

    insert into public.document_items (
      document_id, product_id, item_code, description, qty, unit_price, unit_cost, discount_type, discount_value, line_total, return_condition
    ) values (
      doc_id,
      item.product_id,
      item.item_code,
      item.description,
      item.qty,
      coalesce(item.unit_price, 0),
      coalesce(item.unit_cost, product_row.avg_cost, 0),
      coalesce(item.discount_type, 'none'),
      coalesce(item.discount_value, 0),
      line_total,
      case when item.qty < 0 then coalesce(item.return_condition, 'sellable') else null end
    );

    if item.qty > 0 then
      if product_row.sellable_qty < item.qty then
        raise exception 'Not enough stock for %. Current stock %, requested %', coalesce(item.item_code, item.description), product_row.sellable_qty, item.qty;
      end if;
      update public.stock_balances
      set sellable_qty = sellable_qty - item.qty,
          updated_at = now()
      where product_id = item.product_id;

      insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
      values (item.product_id, doc_id, 'sale', -1 * item.qty, coalesce(item.unit_cost, product_row.avg_cost, 0), 'POS invoice sale');
    else
      if coalesce(item.return_condition, 'sellable') = 'warranty_damaged' then
        update public.stock_balances
        set damaged_qty = damaged_qty + abs(item.qty),
            updated_at = now()
        where product_id = item.product_id;

        insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
        values (item.product_id, doc_id, 'return_damaged', abs(item.qty), coalesce(item.unit_cost, product_row.avg_cost, 0), 'POS return moved to warranty/damaged');
      else
        update public.stock_balances
        set sellable_qty = sellable_qty + abs(item.qty),
            updated_at = now()
        where product_id = item.product_id;

        insert into public.stock_movements (product_id, document_id, movement_type, qty, unit_cost, notes)
        values (item.product_id, doc_id, 'return_sellable', abs(item.qty), coalesce(item.unit_cost, product_row.avg_cost, 0), 'POS return moved to sellable stock');
      end if;
    end if;
  end loop;

  if pm.is_paid_method and pm.affects_cashflow then
    insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
    values (
      doc_id,
      case when final_total < 0 then 'cash_out' else 'cash_in' end,
      pm.name,
      pm_id,
      abs(final_total),
      case when final_total < 0 then 'POS refund/payment out ' || doc_no else 'POS sale payment ' || doc_no end
    );
  else
    insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
    values (
      doc_id,
      'non_cash',
      pm.name,
      pm_id,
      abs(final_total),
      case when final_total < 0 then 'Store credit / non-cash refund ' || doc_no else 'Credit sale / non-cash payment ' || doc_no end
    );
  end if;

  if cust_id is not null then
    if final_total > 0 and pm.is_paid_method = false then
      update public.customers
      set due_balance = coalesce(due_balance, 0) + final_total,
          updated_at = now()
      where id = cust_id;
    elsif final_total < 0 then
      if pm.is_paid_method = false or lower(pm.name) like '%store credit%' then
        update public.customers
        set store_credit_balance = coalesce(store_credit_balance, 0) + abs(final_total),
            updated_at = now()
        where id = cust_id;
      end if;
    elsif final_total > 0 and lower(pm.name) like '%store credit%' then
      update public.customers
      set store_credit_balance = greatest(coalesce(store_credit_balance, 0) - final_total, 0),
          updated_at = now()
      where id = cust_id;
    end if;
  end if;

  return jsonb_build_object('id', doc_id, 'document_no', doc_no, 'total_amount', final_total);
end;
$$;

grant execute on function public.save_pos_invoice(jsonb, jsonb) to authenticated;
