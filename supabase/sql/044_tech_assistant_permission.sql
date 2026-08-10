-- Permission gate for the Gemini technical assistant.
-- Run after 038 and 039.

begin;

-- Existing staff receive the normal-staff default. Administrators already
-- receive all permissions through has_pos_permission_v38().
update public.staff
set permissions = jsonb_set(coalesce(permissions, '{}'::jsonb), '{use_ai_assistant}', 'true'::jsonb, true),
    updated_at = now()
where role = 'staff'
  and not (coalesce(permissions, '{}'::jsonb) ? 'use_ai_assistant');

create or replace function public.can_use_tech_assistant_v44()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(public.has_pos_permission_v38('use_ai_assistant'), false);
$$;

revoke all on function public.can_use_tech_assistant_v44() from public, anon;
grant execute on function public.can_use_tech_assistant_v44() to authenticated;

commit;
