-- v32: Dedicated repair/job workflow timestamps and safe status updates.
-- Run once after 031_daily_backups_party_rules.sql.

alter table public.documents
  add column if not exists job_ready_at timestamptz,
  add column if not exists job_completed_at timestamptz;

create index if not exists documents_job_workflow_idx
  on public.documents(document_type, job_status, document_date desc)
  where document_type = 'job';

create or replace function public.update_job_status_v32(
  p_document_id uuid,
  p_job_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_status text := lower(trim(coalesce(p_job_status, '')));
  updated_job public.documents%rowtype;
begin
  if clean_status not in ('received', 'checking', 'waiting_parts', 'ready', 'completed', 'cancelled') then
    raise exception 'Unsupported job status: %', clean_status;
  end if;

  update public.documents
  set job_status = clean_status,
      status = clean_status,
      job_ready_at = case
        when clean_status in ('ready', 'completed') then coalesce(job_ready_at, now())
        else job_ready_at
      end,
      job_completed_at = case
        when clean_status = 'completed' then coalesce(job_completed_at, now())
        else null
      end,
      updated_at = now()
  where id = p_document_id and document_type = 'job'
  returning * into updated_job;

  if not found then raise exception 'Job not found'; end if;

  return jsonb_build_object(
    'id', updated_job.id,
    'job_no', updated_job.job_no,
    'job_status', updated_job.job_status,
    'job_ready_at', updated_job.job_ready_at,
    'job_completed_at', updated_job.job_completed_at
  );
end;
$$;

revoke all on function public.update_job_status_v32(uuid, text) from public;
grant execute on function public.update_job_status_v32(uuid, text) to authenticated;

notify pgrst, 'reload schema';
