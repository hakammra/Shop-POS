-- v35: Let POS choose whether an existing customer credit is applied to a new bill.
-- Run once after 034_warranty_register_and_claims.sql.

create or replace function public.save_pos_invoice_v35(
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
  result jsonb;
  doc_id uuid;
  keep_credit boolean := not coalesce((p_header ->> 'use_existing_customer_credit')::boolean, true);
begin
  result := public.save_pos_invoice_v28(p_header, p_items, p_payments);
  doc_id := (result ->> 'id')::uuid;

  -- The v20 accounting function derives "balance applied" for display from the
  -- customer's previous balance. When the current bill was paid separately,
  -- the actual outstanding delta is already correct; remove only that misleading
  -- display note and return the real applied value to the client.
  if keep_credit and coalesce((result ->> 'balance_applied')::numeric, 0) > 0 then
    update public.documents
    set notes = nullif(trim(regexp_replace(
      coalesce(notes, ''),
      E'(^|\\n)Existing outstanding balance applied to this document: [^\\n]*',
      '',
      'g'
    )), ''),
        updated_at = now()
    where id = doc_id;

    result := result || jsonb_build_object('balance_applied', 0);
  end if;

  return result;
end;
$$;

revoke all on function public.save_pos_invoice_v35(jsonb, jsonb, jsonb) from public;
grant execute on function public.save_pos_invoice_v35(jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
