-- v73: Assign new repair jobs a short, non-sequential five-character code.
-- Existing job numbers are not changed.
-- Run once after 072_purchase_edit_final_stock_validation.sql.

begin;

create unique index if not exists documents_job_no_unique
on public.documents(job_no)
where job_no is not null;

create or replace function public.next_job_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  character_index integer;
begin
  -- Serialise only the tiny code-generation section. This ensures two jobs
  -- saved at the same moment cannot be given the same available code.
  perform pg_advisory_xact_lock(730022);

  loop
    candidate := '';
    for character_index in 1..5 loop
      candidate := candidate || substr(
        alphabet,
        1 + floor(random() * length(alphabet))::integer,
        1
      );
    end loop;

    -- A mixed code is easier to distinguish from the old sequential numbers.
    if candidate ~ '[A-Z]'
       and candidate ~ '[0-9]'
       and not exists (
         select 1
         from public.documents d
         where d.job_no = candidate
       ) then
      return candidate;
    end if;
  end loop;
end;
$$;

create or replace function public.save_job_document_v73(
  p_customer_id uuid,
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
begin
  return public.save_job_document_v22(
    p_customer_id,
    null,
    p_document_date,
    p_device_type,
    p_device_specs,
    p_problem,
    p_accessories,
    p_estimated_days,
    p_job_status,
    p_notes
  );
end;
$$;

revoke all on function public.save_job_document_v73(uuid, date, text, text, text, text, integer, text, text) from public;
grant execute on function public.save_job_document_v73(uuid, date, text, text, text, text, integer, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
