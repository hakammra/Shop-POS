-- v22: Job / repair intake document and POS quote shortcut support.
-- Run this once after v21/v20 SQL files.

alter table public.documents add column if not exists job_no text;
alter table public.documents add column if not exists job_status text;
alter table public.documents add column if not exists device_type text;
alter table public.documents add column if not exists device_specs text;
alter table public.documents add column if not exists job_problem text;
alter table public.documents add column if not exists job_accessories text;
alter table public.documents add column if not exists estimated_days integer;

create unique index if not exists documents_job_no_unique
on public.documents(job_no)
where job_no is not null;

drop function if exists public.next_job_no();
create or replace function public.next_job_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text := to_char(current_date, 'DDMM');
  next_seq integer;
begin
  select coalesce(max(right(job_no, 3)::integer), 0) + 1
  into next_seq
  from public.documents
  where document_type = 'job'
    and job_no ~ ('^' || prefix || '[0-9]{3}$');

  return prefix || lpad(next_seq::text, 3, '0');
end;
$$;

grant execute on function public.next_job_no() to authenticated;

drop function if exists public.save_job_document_v22(uuid, text, date, text, text, text, text, integer, text, text);
create or replace function public.save_job_document_v22(
  p_customer_id uuid,
  p_job_no text,
  p_document_date date,
  p_device_type text,
  p_device_specs text,
  p_problem text,
  p_accessories text,
  p_estimated_days integer,
  p_job_status text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_id uuid;
  job_no_final text := nullif(trim(coalesce(p_job_no, '')), '');
  document_no_final text;
begin
  if p_customer_id is null then
    raise exception 'Customer is required for a repair/job document';
  end if;

  if job_no_final is null then
    job_no_final := public.next_job_no();
  end if;

  document_no_final := public.next_document_no('job');

  insert into public.documents (
    document_no,
    job_no,
    document_type,
    status,
    job_status,
    customer_id,
    total_amount,
    paid_amount,
    balance_amount,
    currency,
    document_date,
    device_type,
    device_specs,
    job_problem,
    job_accessories,
    estimated_days,
    notes
  ) values (
    document_no_final,
    job_no_final,
    'job',
    coalesce(nullif(p_job_status, ''), 'received'),
    coalesce(nullif(p_job_status, ''), 'received'),
    p_customer_id,
    0,
    0,
    0,
    'LKR',
    coalesce(p_document_date, current_date)::timestamp + time '12:00',
    nullif(trim(coalesce(p_device_type, '')), ''),
    nullif(trim(coalesce(p_device_specs, '')), ''),
    nullif(trim(coalesce(p_problem, '')), ''),
    nullif(trim(coalesce(p_accessories, '')), ''),
    coalesce(p_estimated_days, 0),
    nullif(trim(coalesce(p_notes, '')), '')
  ) returning id into doc_id;

  return jsonb_build_object('id', doc_id, 'document_no', document_no_final, 'job_no', job_no_final);
end;
$$;

grant execute on function public.save_job_document_v22(uuid, text, date, text, text, text, text, integer, text, text) to authenticated;
