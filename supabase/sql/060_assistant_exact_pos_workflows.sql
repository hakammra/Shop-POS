-- Exact, application-specific POS handbook retrieval.
-- Run after 059_assistant_pos_staff_handbook.sql, then redeploy tech-assistant.

update public.assistant_pos_guides
set area = 'COD Orders',
    keywords = array['cod', 'cod order', 'cash on delivery', 'courier', 'dispatch', 'packing', 'settlement', 'placed by'],
    content = 'COD orders are created only from the COD Orders page; do not create a normal POS sale or choose COD as a POS payment method. 1. Open COD Orders and choose New Order. 2. Enter the recipient, phone, delivery address, order source, delivery service, delivery charge, and products. The active PIN-unlocked staff member is recorded automatically as Placed by. 3. Save the order. It reserves stock but does not create a sales invoice or cashflow entry. 4. Select the order in the COD Order Queue. Use Edit, Print Label, Print Bill, or Open Tracking from the top toolbar when needed. 5. Choose Update / Workflow, then move the order through Mark Packed, Mark Dispatched, and Mark Delivered / Awaiting Payment. If it comes back, use Mark Returned and enter the return charge and reason. 6. After the courier pays the shop, open Update / Workflow, enter Net amount received, select the payment method, and choose Payment Received - Create Sale. Only this final action creates the sales invoice, records payment/cashflow, and finishes the COD order.' ,
    is_active = true,
    updated_at = now()
where lower(topic) = 'create and process a cod order';

create or replace function public.assistant_search_pos_guides_v60(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.has_pos_permission_v38('use_ai_assistant') then
    raise exception 'Tech Assistant permission required';
  end if;

  with input as (
    select lower(regexp_replace(coalesce(p_query, ''), '[^[:alnum:] ]', ' ', 'g')) as query_text
  ), query_words as (
    select distinct word
    from input, regexp_split_to_table(input.query_text, '\s+') word
    where length(word) >= 3
      and word not in ('and','are','can','could','does','for','from','how','into','make','process','should','that','the','this','use','what','when','where','with')
  ), ranked as (
    select g.*,
      (
        select count(*) * 12 from query_words q
        where lower(g.topic) like '%' || q.word || '%'
      ) + (
        select count(*) * 8 from query_words q
        where lower(g.area) like '%' || q.word || '%'
      ) + (
        select count(*) * 9 from query_words q
        where lower(array_to_string(g.keywords, ' ')) like '%' || q.word || '%'
      ) + (
        select count(*) * 30
        from input i, unnest(g.keywords) keyword
        where length(trim(keyword)) >= 3
          and i.query_text like '%' || lower(trim(keyword)) || '%'
      ) + (
        select count(*) from query_words q
        where lower(g.content) like '%' || q.word || '%'
      ) as match_score
    from public.assistant_pos_guides g
    where g.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'topic', r.topic,
    'area', r.area,
    'keywords', r.keywords,
    'content', r.content,
    'updated_at', r.updated_at
  ) order by r.match_score desc, r.topic) filter (where r.match_score > 0), '[]'::jsonb)
  into result
  from (
    select * from ranked
    where match_score > 0
    order by match_score desc, topic
    limit 5
  ) r;

  return result;
end;
$$;

revoke all on function public.assistant_search_pos_guides_v60(text) from public;
grant execute on function public.assistant_search_pos_guides_v60(text) to authenticated;
