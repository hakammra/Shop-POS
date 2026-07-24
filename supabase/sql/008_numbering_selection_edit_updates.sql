-- v8 updates: numeric document numbering style.
-- Run once after 007_document_numbering_stock_fix.sql.
-- Format: YY + document account code + 5-digit sequence.
-- Example in 2026: sale/invoice = 2610000001, purchase = 2620000001, stock in transit = 2630000001.

create or replace function public.next_document_no(p_document_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  account_code text;
  doc_year integer;
  short_year text;
  next_no integer;
begin
  account_code := case p_document_type
    when 'invoice' then '100'
    when 'sale' then '100'
    when 'purchase' then '200'
    when 'stock_in_transit' then '300'
    when 'quotation' then '400'
    when 'refund' then '500'
    when 'stock_adjustment' then '600'
    when 'trade_in' then '700'
    when 'customer_payment' then '800'
    when 'supplier_payment' then '850'
    when 'expense' then '900'
    when 'online_order' then '110'
    else '999'
  end;

  doc_year := extract(year from now())::integer;
  short_year := lpad((doc_year % 100)::text, 2, '0');

  insert into public.document_sequences (document_type, document_year, last_no)
  values (p_document_type, doc_year, 1)
  on conflict (document_type, document_year)
  do update set last_no = public.document_sequences.last_no + 1
  returning last_no into next_no;

  return short_year || account_code || lpad(next_no::text, 5, '0');
end;
$$;

grant execute on function public.next_document_no(text) to authenticated;
