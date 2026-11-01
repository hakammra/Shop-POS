-- Retry-safe replacement of a completed Retail invoice when its Wholesale
-- Catalog products or quantities change. Apply after 087.
--
-- The Edge Function coordinates the existing idempotent Wholesale cancellation
-- and sale endpoints. This table is the durable Retail outbox for the complete
-- correction, including the case where the corrected bill has no Wholesale
-- Catalog items left.

begin;

create table if not exists public.retail_wholesale_replacements (
  id uuid primary key,
  original_transfer_id uuid not null references public.retail_wholesale_transfers(id),
  replacement_transfer_id uuid references public.retail_wholesale_transfers(id),
  original_invoice_document_id uuid,
  replacement_invoice_document_id uuid references public.documents(id) on delete set null,
  original_invoice_no text not null,
  request_fingerprint text not null,
  request_payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'failed', 'completed')),
  next_step text not null default 'cancel_original'
    check (next_step in ('cancel_original', 'prepare_replacement', 'post_replacement', 'post_retail_only', 'complete')),
  requested_by_staff_id uuid references public.staff(id) on delete set null,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists retail_wholesale_replacements_original_idx
  on public.retail_wholesale_replacements(original_transfer_id);
create index if not exists retail_wholesale_replacements_pending_idx
  on public.retail_wholesale_replacements(status, updated_at desc);

alter table public.retail_wholesale_replacements enable row level security;

create or replace function public.prepare_retail_wholesale_replacement_v88(
  p_document_id uuid,
  p_replacement_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  existing public.retail_wholesale_replacements%rowtype;
  original_transfer public.retail_wholesale_transfers%rowtype;
  original_document public.documents%rowtype;
  operator_id uuid;
  fingerprint text;
  normalized_payload jsonb;
  prepared_cancellation jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if p_replacement_id is null then raise exception 'A stable replacement ID is required'; end if;
  operator_id := public.current_pos_staff_id_v38();
  if operator_id is null then raise exception 'POS is locked. Enter a staff PIN first'; end if;
  if not public.has_pos_permission_v38('edit_sales_documents') then
    raise exception 'Edit finalized sales documents permission required';
  end if;
  if not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Wholesale item corrections also require Delete finalized sales documents permission';
  end if;

  fingerprint := encode(extensions.digest(coalesce(p_payload, '{}'::jsonb)::text, 'sha256'::text), 'hex');
  select * into existing
  from public.retail_wholesale_replacements
  where id = p_replacement_id
  for update;
  if found then
    if existing.original_invoice_document_id is distinct from p_document_id then
      raise exception 'This replacement ID belongs to a different invoice';
    end if;
    if existing.request_fingerprint <> fingerprint then
      raise exception 'This pending Wholesale invoice correction belongs to an earlier version of the bill. Retry it unchanged';
    end if;
    return to_jsonb(existing) || jsonb_build_object('requires_replacement', true, 'is_wholesale', true);
  end if;

  select * into original_transfer
  from public.retail_wholesale_transfers
  where retail_invoice_document_id = p_document_id
  for update;
  if not found then
    return jsonb_build_object('requires_replacement', false, 'is_wholesale', false);
  end if;
  if original_transfer.status <> 'retail_posted' then
    raise exception 'This Wholesale-linked sale is currently % and cannot be corrected', replace(original_transfer.status, '_', ' ');
  end if;
  if jsonb_array_length(coalesce(original_transfer.wholesale_request -> 'returns', '[]'::jsonb)) > 0 then
    raise exception 'A sale containing a linked Wholesale return cannot be replaced automatically';
  end if;

  -- Price, party, date and Retail payment edits do not require a cross-store
  -- replacement. Compare product-specific Wholesale quantities, not just the
  -- total number of units on the bill.
  if not exists (
    with old_lines as (
      select link.wholesale_product_id, round(sum(item.qty), 3) qty
      from public.document_items item
      join public.retail_wholesale_product_links link on link.retail_product_id = item.product_id
      where item.document_id = p_document_id
      group by link.wholesale_product_id
    ), new_lines as (
      select link.wholesale_product_id, round(sum(coalesce((item ->> 'qty')::numeric, 0)), 3) qty
      from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) item
      join public.retail_wholesale_product_links link
        on link.retail_product_id = nullif(item ->> 'product_id', '')::uuid
      group by link.wholesale_product_id
    )
    select 1
    from old_lines old_line
    full join new_lines new_line using (wholesale_product_id)
    where coalesce(old_line.qty, 0) <> coalesce(new_line.qty, 0)
  ) then
    return jsonb_build_object(
      'requires_replacement', false,
      'is_wholesale', true,
      'transfer_id', original_transfer.id
    );
  end if;

  select * into original_document
  from public.documents
  where id = p_document_id and document_type = 'invoice'
  for update;
  if not found then raise exception 'The original Retail sales invoice was not found'; end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) item
    join public.retail_wholesale_product_links link
      on link.retail_product_id = nullif(item ->> 'product_id', '')::uuid
    where coalesce((item ->> 'qty')::numeric, 0) > 0
      and not link.is_enabled
  ) then
    raise exception 'One or more replacement Wholesale Catalog items are no longer available';
  end if;

  normalized_payload := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
    'header', coalesce(p_payload -> 'header', '{}'::jsonb) || jsonb_build_object(
      'document_no', original_document.document_no,
      'document_date', coalesce(nullif(p_payload -> 'header' ->> 'document_date', ''), original_document.document_date::date::text)
    )
  );

  insert into public.retail_wholesale_replacements(
    id, original_transfer_id, original_invoice_document_id, original_invoice_no,
    request_fingerprint, request_payload, requested_by_staff_id
  ) values (
    p_replacement_id, original_transfer.id, original_document.id, original_document.document_no,
    fingerprint, normalized_payload, operator_id
  ) returning * into existing;

  -- This performs all dependency checks and arms the existing retry-safe
  -- cancellation. The insert above rolls back if any check fails.
  prepared_cancellation := public.prepare_retail_wholesale_cancellation_v81(p_document_id);
  return to_jsonb(existing) || jsonb_build_object(
    'requires_replacement', true,
    'is_wholesale', true,
    'cancellation', prepared_cancellation
  );
end;
$$;

create or replace function public.prepare_retail_wholesale_replacement_transfer_v88(p_replacement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  replacement public.retail_wholesale_replacements%rowtype;
  original_transfer public.retail_wholesale_transfers%rowtype;
  new_transfer public.retail_wholesale_transfers%rowtype;
  request_items jsonb;
  replacement_reference text;
  transfer_id uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('edit_sales_documents')
     or not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Wholesale invoice replacement permission required';
  end if;

  select * into replacement
  from public.retail_wholesale_replacements
  where id = p_replacement_id
  for update;
  if not found then raise exception 'Wholesale invoice replacement was not found'; end if;
  if replacement.status = 'completed' then return to_jsonb(replacement); end if;

  select * into original_transfer
  from public.retail_wholesale_transfers
  where id = replacement.original_transfer_id
  for update;
  if not found or original_transfer.status <> 'cancelled' then
    raise exception 'The original Wholesale transfer must be fully cancelled before its replacement is posted';
  end if;

  if replacement.replacement_transfer_id is not null then
    select * into new_transfer
    from public.retail_wholesale_transfers
    where id = replacement.replacement_transfer_id;
    update public.retail_wholesale_replacements
    set status = 'pending', next_step = 'post_replacement', last_error = null, updated_at = now()
    where id = replacement.id
    returning * into replacement;
    return to_jsonb(replacement) || jsonb_build_object('transfer', to_jsonb(new_transfer));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('product_id', lines.wholesale_product_id, 'qty', lines.qty)
    order by lines.wholesale_product_id), '[]'::jsonb)
  into request_items
  from (
    select link.wholesale_product_id, sum((item ->> 'qty')::numeric) qty
    from jsonb_array_elements(replacement.request_payload -> 'items') item
    join public.retail_wholesale_product_links link
      on link.retail_product_id = (item ->> 'product_id')::uuid
    where coalesce((item ->> 'qty')::numeric, 0) > 0
    group by link.wholesale_product_id
  ) lines;

  if jsonb_array_length(request_items) = 0 then
    update public.retail_wholesale_replacements
    set status = 'pending', next_step = 'post_retail_only', last_error = null, updated_at = now()
    where id = replacement.id
    returning * into replacement;
    return to_jsonb(replacement);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(request_items) requested
    join public.retail_wholesale_product_links link
      on link.wholesale_product_id = (requested ->> 'product_id')::uuid
    where not link.is_enabled
  ) then
    raise exception 'One or more replacement Wholesale Catalog items are no longer available';
  end if;

  transfer_id := gen_random_uuid();
  replacement_reference := replacement.original_invoice_no || '~R' || upper(substr(replace(replacement.id::text, '-', ''), 1, 8));
  insert into public.retail_wholesale_transfers(
    id, idempotency_key, request_fingerprint, status, next_step, retail_sale_reference,
    request_payload, wholesale_request, requested_by_staff_id
  ) values (
    transfer_id,
    'retail-replacement:' || replacement.id::text,
    replacement.request_fingerprint,
    'pending',
    'wholesale_post',
    replacement_reference,
    replacement.request_payload,
    jsonb_build_object(
      'action', 'post_sale',
      'idempotency_key', 'retail-replacement:' || replacement.id::text,
      'retail_sale_reference', replacement_reference,
      'sale_date', coalesce(nullif(replacement.request_payload -> 'header' ->> 'document_date', ''), current_date::text),
      'items', request_items,
      'returns', '[]'::jsonb
    ),
    replacement.requested_by_staff_id
  ) returning * into new_transfer;

  update public.retail_wholesale_replacements
  set replacement_transfer_id = new_transfer.id,
      status = 'pending', next_step = 'post_replacement', last_error = null, updated_at = now()
  where id = replacement.id
  returning * into replacement;
  return to_jsonb(replacement) || jsonb_build_object('transfer', to_jsonb(new_transfer));
end;
$$;

create or replace function public.post_retail_wholesale_replacement_without_catalog_v88(p_replacement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  replacement public.retail_wholesale_replacements%rowtype;
  original_transfer public.retail_wholesale_transfers%rowtype;
  invoice_result jsonb;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if not public.has_pos_permission_v38('edit_sales_documents')
     or not public.has_pos_permission_v38('delete_sales_documents') then
    raise exception 'Wholesale invoice replacement permission required';
  end if;
  select * into replacement
  from public.retail_wholesale_replacements
  where id = p_replacement_id
  for update;
  if not found then raise exception 'Wholesale invoice replacement was not found'; end if;
  if replacement.status = 'completed' then
    return jsonb_build_object(
      'invoice', jsonb_build_object('id', replacement.replacement_invoice_document_id, 'document_no', replacement.original_invoice_no),
      'already_posted', true,
      'replacement_id', replacement.id
    );
  end if;
  if replacement.next_step <> 'post_retail_only' then
    raise exception 'This Wholesale invoice replacement is not ready for its Retail-only posting step';
  end if;
  select * into original_transfer from public.retail_wholesale_transfers where id = replacement.original_transfer_id;
  if not found or original_transfer.status <> 'cancelled' then
    raise exception 'The original Wholesale transfer has not been fully cancelled';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(replacement.request_payload -> 'items') item
    join public.retail_wholesale_product_links link
      on link.retail_product_id = nullif(item ->> 'product_id', '')::uuid
    where coalesce((item ->> 'qty')::numeric, 0) > 0
  ) then
    raise exception 'The corrected bill still contains Wholesale Catalog items and must use the replacement transfer';
  end if;

  invoice_result := public.save_pos_invoice_v74(
    replacement.request_payload -> 'header',
    replacement.request_payload -> 'items',
    replacement.request_payload -> 'payments'
  );
  update public.retail_wholesale_replacements
  set replacement_invoice_document_id = (invoice_result ->> 'id')::uuid,
      status = 'completed', next_step = 'complete', last_error = null,
      completed_at = now(), updated_at = now()
  where id = replacement.id;
  return jsonb_build_object(
    'invoice', invoice_result,
    'replacement_id', replacement.id,
    'already_posted', false
  );
end;
$$;

create or replace function public.finalize_retail_wholesale_replacement_v88(
  p_replacement_id uuid,
  p_invoice_document_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  replacement public.retail_wholesale_replacements%rowtype;
  new_transfer public.retail_wholesale_transfers%rowtype;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  select * into replacement
  from public.retail_wholesale_replacements
  where id = p_replacement_id
  for update;
  if not found then raise exception 'Wholesale invoice replacement was not found'; end if;
  if replacement.status = 'completed' then return to_jsonb(replacement); end if;
  select * into new_transfer
  from public.retail_wholesale_transfers
  where id = replacement.replacement_transfer_id;
  if not found or new_transfer.status <> 'retail_posted'
     or new_transfer.retail_invoice_document_id is distinct from p_invoice_document_id then
    raise exception 'The replacement Wholesale transfer has not completed its Retail invoice';
  end if;
  update public.retail_wholesale_replacements
  set replacement_invoice_document_id = p_invoice_document_id,
      status = 'completed', next_step = 'complete', last_error = null,
      completed_at = now(), updated_at = now()
  where id = replacement.id
  returning * into replacement;
  return to_jsonb(replacement);
end;
$$;

-- Present a replacement as one retryable operation and hide its component
-- cancellation/new-sale transfer rows from the administrator queue.
create or replace function public.get_pending_retail_wholesale_transfers_v76()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  perform public.authorize_retail_wholesale_admin_v76();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]'::jsonb)
  into result
  from (
    select t.id, 'transfer'::text kind, t.status, t.next_step, t.retail_sale_reference,
      t.wholesale_document_no, t.attempt_count, t.last_error, t.created_at, t.updated_at,
      s.full_name requested_by
    from public.retail_wholesale_transfers t
    left join public.staff s on s.id = t.requested_by_staff_id
    where t.status not in ('retail_posted', 'cancelled')
      and not exists (
        select 1 from public.retail_wholesale_replacements r
        where r.status <> 'completed'
          and (r.original_transfer_id = t.id or r.replacement_transfer_id = t.id)
      )
    union all
    select r.id, 'replacement'::text kind, r.status, r.next_step, r.original_invoice_no,
      coalesce(new_transfer.wholesale_document_no, original_transfer.wholesale_document_no),
      r.attempt_count, r.last_error, r.created_at, r.updated_at, s.full_name
    from public.retail_wholesale_replacements r
    join public.retail_wholesale_transfers original_transfer on original_transfer.id = r.original_transfer_id
    left join public.retail_wholesale_transfers new_transfer on new_transfer.id = r.replacement_transfer_id
    left join public.staff s on s.id = r.requested_by_staff_id
    where r.status <> 'completed'
  ) x;
  return result;
end;
$$;

revoke all on table public.retail_wholesale_replacements from public, anon, authenticated;
revoke all on function public.prepare_retail_wholesale_replacement_v88(uuid, uuid, jsonb) from public;
revoke all on function public.prepare_retail_wholesale_replacement_transfer_v88(uuid) from public;
revoke all on function public.post_retail_wholesale_replacement_without_catalog_v88(uuid) from public;
revoke all on function public.finalize_retail_wholesale_replacement_v88(uuid, uuid) from public;
grant execute on function public.prepare_retail_wholesale_replacement_v88(uuid, uuid, jsonb) to authenticated;
grant execute on function public.prepare_retail_wholesale_replacement_transfer_v88(uuid) to authenticated;
grant execute on function public.post_retail_wholesale_replacement_without_catalog_v88(uuid) to authenticated;
grant execute on function public.finalize_retail_wholesale_replacement_v88(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
