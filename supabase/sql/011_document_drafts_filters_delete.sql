-- v11: document drafts/filter UI support + safe delete for Purchase / Stock in Transit.
-- Run once after 010_document_edit_reapply_updates.sql.

create or replace function public.delete_purchase_like_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
begin
  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'Document not found';
  end if;

  if doc.document_type not in ('purchase', 'stock_in_transit') then
    raise exception 'Only Purchase and Stock in Transit documents can be deleted with automatic stock reversal now';
  end if;

  if doc.document_type = 'stock_in_transit' and doc.status = 'converted' then
    raise exception 'This Stock in Transit document is already converted. Delete/edit the linked Purchase document instead.';
  end if;

  -- Reverse old stock effect first. This function sets status back to draft after reversal.
  perform public.reverse_purchase_like_document(p_document_id);

  -- Remove payment/cashflow rows for the document before deleting it.
  delete from public.cashflow_entries where document_id = p_document_id;

  -- document_items are deleted by cascade.
  delete from public.documents where id = p_document_id;
end;
$$;

grant execute on function public.delete_purchase_like_document(uuid) to authenticated;
