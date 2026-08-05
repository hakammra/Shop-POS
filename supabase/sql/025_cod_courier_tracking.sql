-- COD courier tracking snapshot support.
-- Run after 024_cod_orders_and_save_time_numbering.sql.

alter table public.documents
  add column if not exists courier_status text,
  add column if not exists courier_status_checked_at timestamptz,
  add column if not exists courier_tracking_data jsonb;

create or replace function public.record_cod_tracking_v25(
  p_document_id uuid,
  p_tracking_number text,
  p_courier_status text,
  p_tracking_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc record;
  next_status text;
  clean_courier_status text := trim(coalesce(p_courier_status, ''));
begin
  select * into doc
  from public.documents
  where id = p_document_id
  for update;

  if not found then raise exception 'COD order not found'; end if;
  if doc.document_type <> 'cod_order' then raise exception 'Document is not a COD order'; end if;
  if clean_courier_status = '' then raise exception 'Courier status is required'; end if;

  next_status := doc.status;
  if lower(clean_courier_status) in ('delivered', 'settled')
     and doc.status in ('packed', 'dispatched') then
    next_status := 'awaiting_settlement';
  end if;

  update public.documents
  set tracking_number = coalesce(nullif(trim(coalesce(p_tracking_number, '')), ''), tracking_number),
      delivery_service = 'SLPOST',
      courier_status = clean_courier_status,
      courier_status_checked_at = now(),
      courier_tracking_data = coalesce(p_tracking_payload, '{}'::jsonb),
      status = next_status,
      delivered_at = case
        when next_status = 'awaiting_settlement' then coalesce(delivered_at, now())
        else delivered_at
      end,
      updated_at = now()
  where id = p_document_id;

  return jsonb_build_object(
    'document_id', p_document_id,
    'courier_status', clean_courier_status,
    'workflow_status', next_status,
    'checked_at', now()
  );
end;
$$;

grant execute on function public.record_cod_tracking_v25(uuid, text, text, jsonb) to authenticated;

