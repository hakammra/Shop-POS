-- Run in Retail Supabase after 083_sales_invoice_buyback_date_corrections.sql.
-- An administrator may cancel an incomplete bridge transfer only after the
-- Wholesale bridge has checked/reversed its matching idempotency key.
begin;

create or replace function public.prepare_pending_retail_wholesale_cancellation_v84(
  p_transfer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare transfer public.retail_wholesale_transfers%rowtype;
begin
  perform public.authorize_retail_wholesale_admin_v76();
  select * into transfer
  from public.retail_wholesale_transfers
  where id = p_transfer_id
  for update;
  if not found then raise exception 'Wholesale transfer not found'; end if;
  if transfer.status = 'cancelled' then
    return jsonb_build_object('transfer_id', transfer.id, 'already_cancelled', true);
  end if;
  if transfer.retail_invoice_document_id is not null
     or transfer.retail_purchase_document_id is not null
     or transfer.status = 'retail_posted' then
    raise exception 'This transfer has a posted Retail sale. Delete its sales invoice from Documents instead';
  end if;
  if transfer.status not in ('pending', 'failed', 'wholesale_posted',
                             'cancel_pending', 'wholesale_cancelled') then
    raise exception 'This transfer cannot be cancelled in its current state';
  end if;

  if transfer.status not in ('cancel_pending', 'wholesale_cancelled') then
    update public.retail_wholesale_transfers
    set status = 'cancel_pending', next_step = 'wholesale_cancel',
        last_error = null, updated_at = now()
    where id = transfer.id;
  end if;

  return jsonb_build_object('transfer_id', transfer.id, 'status', transfer.status);
end;
$$;

create or replace function public.finalize_pending_retail_wholesale_cancellation_v84(
  p_transfer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare transfer public.retail_wholesale_transfers%rowtype;
begin
  perform public.authorize_retail_wholesale_admin_v76();
  select * into transfer
  from public.retail_wholesale_transfers
  where id = p_transfer_id
  for update;
  if not found then raise exception 'Wholesale transfer not found'; end if;
  if transfer.status = 'cancelled' then
    return jsonb_build_object('cancelled', true, 'already_cancelled', true,
      'transfer_id', transfer.id, 'document_no', transfer.retail_sale_reference);
  end if;
  if transfer.status <> 'wholesale_cancelled'
     or coalesce((transfer.wholesale_cancellation_response->>'cancelled')::boolean, false) is not true then
    raise exception 'Wholesale cancellation must be confirmed before closing this transfer';
  end if;
  if transfer.retail_invoice_document_id is not null
     or transfer.retail_purchase_document_id is not null then
    raise exception 'A Retail document was posted; use sales invoice cancellation instead';
  end if;

  update public.retail_wholesale_transfers
  set status = 'cancelled', next_step = 'complete', last_error = null,
      cancelled_at = now(), updated_at = now()
  where id = transfer.id;
  return jsonb_build_object('cancelled', true, 'transfer_id', transfer.id,
    'document_no', transfer.retail_sale_reference,
    'wholesale_document_no', transfer.wholesale_document_no);
end;
$$;

-- A checkout that was already in flight must not commit Retail documents after
-- cancellation starts. The posting RPC's document writes and status update run
-- in one transaction, so this guard rolls all of those writes back.
create or replace function public.guard_pending_wholesale_cancel_v84()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('cancel_pending', 'wholesale_cancelled', 'cancelled')
     and new.status in ('wholesale_posted', 'retail_posted') then
    raise exception 'This Wholesale transfer is being cancelled and cannot be posted';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_pending_wholesale_cancel_v84
  on public.retail_wholesale_transfers;
create trigger guard_pending_wholesale_cancel_v84
before update on public.retail_wholesale_transfers
for each row execute function public.guard_pending_wholesale_cancel_v84();

revoke all on function public.prepare_pending_retail_wholesale_cancellation_v84(uuid) from public;
revoke all on function public.finalize_pending_retail_wholesale_cancellation_v84(uuid) from public;
grant execute on function public.prepare_pending_retail_wholesale_cancellation_v84(uuid) to authenticated;
grant execute on function public.finalize_pending_retail_wholesale_cancellation_v84(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
