-- v15: POS payment popup / split payments / single outstanding-balance behavior.
-- Run once after v14. It replaces save_pos_invoice with a 3-argument version.

alter table public.payment_methods
  add column if not exists is_paid_method boolean not null default true;

update public.payment_methods
set is_paid_method = false,
    affects_cashflow = false
where lower(name) in ('credit', 'store credit');

update public.payment_methods
set is_paid_method = true
where lower(name) in ('cash', 'card', 'bank', 'bank transfer', 'online payment');

insert into public.payment_methods (name, affects_cashflow, is_paid_method, is_active)
values
  ('Cash', true, true, true),
  ('Card', true, true, true),
  ('Bank', true, true, true),
  ('Credit', false, false, true)
on conflict (name) do update
set is_active = true,
    is_paid_method = excluded.is_paid_method,
    affects_cashflow = excluded.affects_cashflow;

create or replace function public.apply_customer_outstanding_delta(
  p_customer_id uuid,
  p_delta numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  current_net numeric(12,2);
  next_net numeric(12,2);
begin
  if p_customer_id is null or coalesce(p_delta, 0) = 0 then
    return 0;
  end if;

  select coalesce(due_balance, 0) - coalesce(store_credit_balance, 0)
  into current_net
  from public.customers
  where id = p_customer_id
  for update;

  if not found then
    raise exception 'Customer not found while updating outstanding balance';
  end if;

  next_net := round(coalesce(current_net, 0) + coalesce(p_delta, 0), 2);

  update public.customers
  set due_balance = greatest(next_net, 0),
      store_credit_balance = greatest(-next_net, 0),
      updated_at = now()
  where id = p_customer_id;

  return next_net;
end;
$$;

grant execute on function public.apply_customer_outstanding_delta(uuid, numeric) to authenticated;

create or replace function public.save_pos_invoice(
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
  doc_id uuid;
  doc_no text;
  cust_id uuid;
  first_pm_id uuid;
  pay record;
  pm record;
  item record;
  product_row record;
  gross numeric(12,2) := 0;
  line_gross numeric(12,2);
  line_discount numeric(12,2);
  line_total numeric(12,2);
  cart_discount numeric(12,2) := 0;
  final_total numeric(12,2) := 0;
  cash_in_total numeric(12,2) := 0;
  refund_out_total numeric(12,2) := 0;
  non_cash_total numeric(12,2) := 0;
  document_paid numeric(12,2) := 0;
  document_balance numeric(12,2) := 0;
  outstanding_delta numeric(12,2) := 0;
  resulting_outstanding numeric(12,2) := 0;
  note_text text;
begin
  doc_no := nullif(p_header ->> 'document_no', '');
  if doc_no is null then
    doc_no := public.next_document_no('invoice');
  end if;

  cust_id := nullif(p_header ->> 'customer_id', '')::uuid;

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

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(
      payment_method_id uuid,
      payment_method_name text,
      amount numeric,
      direction text
    )
  loop
    if coalesce(pay.amount, 0) <= 0 then
      raise exception 'Payment amount must be greater than zero';
    end if;
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if not found then
      raise exception 'Payment method not found';
    end if;
    if first_pm_id is null then
      first_pm_id := pm.id;
    end if;
    if pm.is_paid_method = false then
      non_cash_total := non_cash_total + pay.amount;
    elsif coalesce(pay.direction, 'in') = 'out' then
      refund_out_total := refund_out_total + pay.amount;
    else
      cash_in_total := cash_in_total + pay.amount;
    end if;
  end loop;

  if cash_in_total + refund_out_total + non_cash_total = 0 then
    raise exception 'Add at least one payment line before saving';
  end if;

  outstanding_delta := round(final_total - cash_in_total + refund_out_total, 2);
  if (cust_id is null) and (final_total < 0 or outstanding_delta <> 0 or non_cash_total > 0) then
    raise exception 'Select a customer for credit, overpayment, old-balance payments, or negative invoices';
  end if;

  if cust_id is not null then
    resulting_outstanding := public.apply_customer_outstanding_delta(cust_id, outstanding_delta);
  end if;

  if final_total > 0 then
    document_paid := least(final_total, cash_in_total);
    document_balance := greatest(final_total - cash_in_total, 0);
  else
    document_paid := least(abs(final_total), refund_out_total);
    document_balance := least(final_total + refund_out_total, 0);
  end if;

  note_text := nullif(p_header ->> 'notes', '');
  if cart_discount <> 0 then
    note_text := concat(coalesce(note_text || E'\n', ''), 'Cart discount: ', cart_discount::text);
  end if;
  if cash_in_total > abs(final_total) and final_total > 0 then
    note_text := concat(coalesce(note_text || E'\n', ''), 'Extra payment against outstanding balance: ', (cash_in_total - final_total)::text);
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
    case when document_balance = 0 then 'completed' when document_balance > 0 then 'unpaid' else 'refund_pending' end,
    cust_id,
    final_total,
    document_paid,
    document_balance,
    'LKR',
    first_pm_id,
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

  for pay in
    select * from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(
      payment_method_id uuid,
      payment_method_name text,
      amount numeric,
      direction text
    )
  loop
    select * into pm from public.payment_methods where id = pay.payment_method_id;
    if pm.is_paid_method = false then
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (doc_id, 'non_cash', pm.name, pm.id, pay.amount, 'Credit/unpaid balance for invoice ' || doc_no);
    elsif coalesce(pay.direction, 'in') = 'out' then
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (doc_id, 'cash_out', pm.name, pm.id, pay.amount, 'POS refund/payment out ' || doc_no);
    else
      insert into public.cashflow_entries (document_id, entry_type, account_name, payment_method_id, amount, description)
      values (doc_id, 'cash_in', pm.name, pm.id, pay.amount, 'POS payment received ' || doc_no);
    end if;
  end loop;

  return jsonb_build_object(
    'id', doc_id,
    'document_no', doc_no,
    'total_amount', final_total,
    'paid_amount', document_paid,
    'balance_amount', document_balance,
    'resulting_outstanding', resulting_outstanding
  );
end;
$$;

grant execute on function public.save_pos_invoice(jsonb, jsonb, jsonb) to authenticated;
