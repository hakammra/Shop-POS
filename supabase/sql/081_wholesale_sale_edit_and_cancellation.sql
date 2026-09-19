-- Safe correction and coordinated cancellation for Retail invoices that were
-- supplied through the Wholesale Catalog bridge. Run after migration 080.

begin;

alter table public.retail_wholesale_transfers
  drop constraint if exists retail_wholesale_transfers_status_check,
  drop constraint if exists retail_wholesale_transfers_next_step_check;

alter table public.retail_wholesale_transfers
  add constraint retail_wholesale_transfers_status_check check (status in (
    'pending', 'wholesale_posted', 'retail_posted', 'failed',
    'cancel_pending', 'wholesale_cancelled', 'cancelled'
  )),
  add constraint retail_wholesale_transfers_next_step_check check (next_step in (
    'wholesale_post', 'retail_post', 'wholesale_cancel', 'retail_cancel', 'complete'
  )),
  add column if not exists wholesale_cancellation_response jsonb,
  add column if not exists cancelled_retail_invoice_document_id uuid,
  add column if not exists cancelled_retail_purchase_document_id uuid,
  add column if not exists cancelled_at timestamptz;

create or replace function public.guard_retail_wholesale_document_v81()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or nullif(current_setting('request.jwt.claims', true), '') is null
     or current_setting('shop_pos.restore_mode', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if exists (
    select 1
    from public.retail_wholesale_transfers transfer
    where transfer.status <> 'cancelled'
      and (transfer.retail_invoice_document_id = old.id or transfer.retail_purchase_document_id = old.id)
  ) then
    if tg_op = 'DELETE' then
      raise exception 'This document belongs to an active Wholesale transfer and cannot be deleted independently';
    end if;
    if nullif(current_setting('shop_pos.retail_wholesale_transfer_id', true), '') is null then
      raise exception 'This document belongs to an active Wholesale transfer and cannot be edited independently';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_retail_wholesale_document_v81_trigger on public.documents;
create trigger guard_retail_wholesale_document_v81_trigger
before update or delete on public.documents
for each row execute function public.guard_retail_wholesale_document_v81();

create or replace function public.get_retail_wholesale_invoice_v81(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare transfer public.retail_wholesale_transfers%rowtype;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if public.current_pos_staff_id_v38() is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  select * into transfer
  from public.retail_wholesale_transfers
  where retail_invoice_document_id = p_document_id
  limit 1;
  if not found then return jsonb_build_object('is_wholesale', false); end if;
  return jsonb_build_object(
    'is_wholesale', true,
    'transfer_id', transfer.id,
    'status', transfer.status,
    'next_step', transfer.next_step,
    'wholesale_document_no', transfer.wholesale_document_no
  );
end;
$$;

create or replace function public.replace_retail_wholesale_invoice_v81(
  p_document_id uuid,
  p_header jsonb,
  p_items jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  transfer public.retail_wholesale_transfers%rowtype;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('edit_sales_documents') then
    raise exception 'Edit sales documents permission required';
  end if;

  select * into transfer
  from public.retail_wholesale_transfers
  where retail_invoice_document_id = p_document_id
  for update;

  if not found then
    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item
      join public.retail_wholesale_product_links link
        on link.retail_product_id = nullif(item ->> 'product_id', '')::uuid
       and link.is_enabled
      where coalesce((item ->> 'qty')::numeric, 0) > 0
    ) then
      raise exception 'An existing normal Retail invoice cannot be changed to include Wholesale Catalog items. Create a new sale instead';
    end if;
    return public.replace_pos_invoice_v67(p_document_id, p_header, p_items, p_payments);
  end if;

  if transfer.status <> 'retail_posted' then
    raise exception 'This Wholesale-linked sale is currently % and cannot be edited', replace(transfer.status, '_', ' ');
  end if;

  if exists (
    with old_lines as (
      select link.wholesale_product_id, round(sum(item.qty), 3) qty
      from public.document_items item
      join public.retail_wholesale_product_links link on link.retail_product_id = item.product_id
      where item.document_id = p_document_id
      group by link.wholesale_product_id
    ), new_lines as (
      select link.wholesale_product_id, round(sum(coalesce((item ->> 'qty')::numeric, 0)), 3) qty
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item
      join public.retail_wholesale_product_links link
        on link.retail_product_id = nullif(item ->> 'product_id', '')::uuid
      group by link.wholesale_product_id
    )
    select 1
    from old_lines old_line
    full join new_lines new_line using (wholesale_product_id)
    where coalesce(old_line.qty, 0) <> coalesce(new_line.qty, 0)
  ) then
    raise exception 'Wholesale Catalog products and quantities cannot be changed on an existing sale. Delete the sale safely and create a new one; prices, customer and Retail payments may be edited';
  end if;

  perform set_config('shop_pos.retail_wholesale_transfer_id', transfer.id::text, true);
  perform set_config('shop_pos.retail_wholesale_operator_id', public.current_pos_staff_id_v38()::text, true);
  result := public.replace_pos_invoice_v67(p_document_id, p_header, p_items, p_payments);

  update public.retail_wholesale_transfers
  set request_payload = jsonb_build_object(
        'header', coalesce(p_header, '{}'::jsonb),
        'items', coalesce(p_items, '[]'::jsonb),
        'payments', coalesce(p_payments, '[]'::jsonb)
      ),
      request_fingerprint = encode(extensions.digest(
        jsonb_build_object(
          'header', coalesce(p_header, '{}'::jsonb),
          'items', coalesce(p_items, '[]'::jsonb),
          'payments', coalesce(p_payments, '[]'::jsonb)
        )::text,
        'sha256'::text
      ), 'hex'),
      last_error = null,
      updated_at = now()
  where id = transfer.id;

  return result || jsonb_build_object(
    'wholesale_transfer_id', transfer.id,
    'wholesale_quantities_unchanged', true
  );
end;
$$;

create or replace function public.prepare_retail_wholesale_cancellation_v81(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer public.retail_wholesale_transfers%rowtype;
  sale_doc public.documents%rowtype;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Delete finalized sales documents permission required';
  end if;

  select * into transfer
  from public.retail_wholesale_transfers
  where retail_invoice_document_id = p_document_id
     or cancelled_retail_invoice_document_id = p_document_id
  for update;
  if not found then raise exception 'This invoice is not linked to a Wholesale Catalog transfer'; end if;

  if transfer.status = 'cancelled' then
    return jsonb_build_object('transfer_id', transfer.id, 'already_cancelled', true);
  end if;
  if transfer.status not in ('retail_posted', 'cancel_pending', 'wholesale_cancelled', 'failed') then
    raise exception 'Wholesale transfer % cannot be cancelled while it is %', transfer.retail_sale_reference, replace(transfer.status, '_', ' ');
  end if;
  if transfer.status = 'failed' and transfer.next_step not in ('wholesale_cancel', 'retail_cancel') then
    raise exception 'This Wholesale transfer failed before the Retail invoice was fully posted and cannot use invoice cancellation';
  end if;

  select * into sale_doc from public.documents where id = transfer.retail_invoice_document_id for update;
  if not found or sale_doc.document_type <> 'invoice' then raise exception 'The linked Retail sales invoice was not found'; end if;
  if exists (
    select 1
    from public.document_items returned_item
    join public.document_items original_item on original_item.id = returned_item.source_document_item_id
    where original_item.document_id = sale_doc.id
  ) then raise exception 'This invoice has a linked return and cannot be deleted'; end if;
  if to_regclass('public.warranty_records') is not null
     and exists (select 1 from public.warranty_records where sale_document_id = sale_doc.id) then
    raise exception 'This invoice has registered warranty records and cannot be deleted';
  end if;
  if exists (select 1 from public.documents where linked_document_id = sale_doc.id) then
    raise exception 'Another document is linked to this invoice, so it cannot be deleted';
  end if;
  if transfer.retail_purchase_document_id is null
     or not exists (select 1 from public.documents where id = transfer.retail_purchase_document_id and document_type = 'purchase') then
    raise exception 'The automatic Retail purchase for this Wholesale transfer was not found';
  end if;

  if transfer.status <> 'wholesale_cancelled' then
    update public.retail_wholesale_transfers
    set status = 'cancel_pending', next_step = 'wholesale_cancel', last_error = null, updated_at = now()
    where id = transfer.id;
  end if;

  return jsonb_build_object(
    'transfer_id', transfer.id,
    'idempotency_key', transfer.idempotency_key,
    'retail_sale_reference', transfer.retail_sale_reference,
    'wholesale_document_id', transfer.wholesale_document_id,
    'wholesale_document_no', transfer.wholesale_document_no,
    'status', case when transfer.status = 'wholesale_cancelled' then 'wholesale_cancelled' else 'cancel_pending' end
  );
end;
$$;

create or replace function public.finalize_retail_wholesale_cancellation_v81(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  transfer public.retail_wholesale_transfers%rowtype;
  invoice_result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Delete finalized sales documents permission required';
  end if;
  select * into transfer from public.retail_wholesale_transfers where id = p_transfer_id for update;
  if not found then raise exception 'Wholesale transfer not found'; end if;
  if transfer.status = 'cancelled' then
    return jsonb_build_object('cancelled', true, 'already_cancelled', true, 'document_no', transfer.retail_sale_reference);
  end if;
  if transfer.status <> 'wholesale_cancelled' then
    raise exception 'Wholesale must be cancelled before Retail effects are reversed';
  end if;

  perform public.prepare_retail_wholesale_cancellation_v81(transfer.retail_invoice_document_id);
  perform set_config('shop_pos.restore_mode', 'on', true);
  invoice_result := public.delete_pos_invoice_v68(transfer.retail_invoice_document_id);
  perform public.delete_purchase_like_document(transfer.retail_purchase_document_id);

  update public.retail_wholesale_transfers
  set cancelled_retail_invoice_document_id = transfer.retail_invoice_document_id,
      cancelled_retail_purchase_document_id = transfer.retail_purchase_document_id,
      status = 'cancelled',
      next_step = 'complete',
      last_error = null,
      cancelled_at = now(),
      updated_at = now()
  where id = transfer.id;

  return coalesce(invoice_result, '{}'::jsonb) || jsonb_build_object(
    'cancelled', true,
    'transfer_id', transfer.id,
    'document_no', transfer.retail_sale_reference,
    'wholesale_document_no', transfer.wholesale_document_no
  );
end;
$$;

create or replace function public.get_pending_retail_wholesale_transfers_v76()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.authorize_retail_wholesale_admin_v76();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb) into result
  from (
    select t.id, t.idempotency_key, t.status, t.next_step, t.retail_sale_reference, t.wholesale_document_no,
      t.wholesale_transfer_total, t.attempt_count, t.last_error, t.created_at, t.updated_at,
      s.full_name as requested_by
    from public.retail_wholesale_transfers t
    left join public.staff s on s.id = t.requested_by_staff_id
    where t.status not in ('retail_posted', 'cancelled')
  ) x;
  return result;
end;
$$;

revoke all on function public.get_retail_wholesale_invoice_v81(uuid) from public;
revoke all on function public.replace_retail_wholesale_invoice_v81(uuid, jsonb, jsonb, jsonb) from public;
revoke all on function public.prepare_retail_wholesale_cancellation_v81(uuid) from public;
revoke all on function public.finalize_retail_wholesale_cancellation_v81(uuid) from public;
grant execute on function public.get_retail_wholesale_invoice_v81(uuid) to authenticated;
grant execute on function public.replace_retail_wholesale_invoice_v81(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.prepare_retail_wholesale_cancellation_v81(uuid) to authenticated;
grant execute on function public.finalize_retail_wholesale_cancellation_v81(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
