-- Keep every POS category available to the online-store category navigator.
-- Existing category visibility choices are preserved.

begin;

insert into public.store_category_content(category_id, is_published)
select c.id, true
from public.categories c
left join public.store_category_content scc on scc.category_id = c.id
where scc.category_id is null
on conflict(category_id) do nothing;

create or replace function public.sync_new_store_category_v49()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.store_category_content(category_id, is_published)
  values(new.id, true)
  on conflict(category_id) do nothing;
  return new;
end;
$$;

drop trigger if exists sync_new_store_category_v49 on public.categories;
create trigger sync_new_store_category_v49
after insert on public.categories
for each row execute function public.sync_new_store_category_v49();

commit;
