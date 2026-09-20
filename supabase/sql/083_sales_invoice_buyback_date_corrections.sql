-- v83: Keep Swap markers during invoice correction and allow an authorized
-- finalized-sale correction to change the document and related cashflow date.
-- Run once after 082_transit_arrival_and_component_credit.sql.

begin;

create or replace function public.replace_retail_wholesale_invoice_v83(
  p_document_id uuid,
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
  prior_document_date date;
  requested_document_date date;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;

  select d.document_date::date
  into prior_document_date
  from public.documents d
  where d.id = p_document_id and d.document_type = 'invoice'
  for update;

  if not found then raise exception 'Sales invoice not found'; end if;

  requested_document_date := coalesce(
    nullif(p_header ->> 'document_date', '')::date,
    prior_document_date
  );
  if requested_document_date > current_date then
    raise exception 'The invoice date cannot be in the future';
  end if;

  -- v81 retains the safe Retail/Wholesale correction workflow. The v82
  -- save function beneath it recognizes line_kind=component_credit, so an
  -- unlinked negative Swap remains distinct from an invoice-linked return.
  result := public.replace_retail_wholesale_invoice_v81(
    p_document_id,
    coalesce(p_header, '{}'::jsonb) || jsonb_build_object('document_date', requested_document_date),
    coalesce(p_items, '[]'::jsonb),
    coalesce(p_payments, '[]'::jsonb)
  );

  if requested_document_date is distinct from prior_document_date then
    -- Cashflow uses created_at for day/range totals. Move it with the invoice
    -- and detach it from the old register shift so a closed shift is not changed.
    update public.cashflow_entries
    set created_at = requested_document_date::timestamptz + interval '12 hours',
        register_shift_id = null
    where document_id = p_document_id;

    update public.documents
    set document_date = requested_document_date::timestamptz,
        updated_at = now()
    where id = p_document_id;

    if to_regprocedure('public.sync_accounting_document_v42(uuid)') is not null then
      perform public.sync_accounting_document_v42(p_document_id);
    end if;
  end if;

  return result || jsonb_build_object(
    'id', p_document_id,
    'document_date', requested_document_date
  );
end;
$$;

revoke all on function public.replace_retail_wholesale_invoice_v83(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.replace_retail_wholesale_invoice_v83(uuid, jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
