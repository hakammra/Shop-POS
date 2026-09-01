-- v54: Keep Tech Assistant product suggestions tightly relevant.
-- Run after 051, then redeploy the tech-assistant Edge Function.

create or replace function public.assistant_search_context_v45(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  clean_query text := left(trim(coalesce(p_query, '')), 500);
  normalized_query text := trim(regexp_replace(lower(left(trim(coalesce(p_query, '')), 500)), '[^[:alnum:]]+', ' ', 'g'));
  compact_query text := regexp_replace(lower(left(trim(coalesce(p_query, '')), 500)), '[^[:alnum:]]+', '', 'g');
  show_cost boolean := false;
  products_json jsonb := '[]'::jsonb;
  knowledge_json jsonb := '[]'::jsonb;
begin
  if not public.has_pos_permission_v38('use_ai_assistant') then
    raise exception 'The active user does not have Tech Assistant permission';
  end if;
  show_cost := public.assistant_is_admin_v45() or public.has_pos_permission_v38('manage_products');

  with raw_terms as (
    select lower(token.term_value) as raw_term
    from regexp_split_to_table(clean_query, E'\\s+') as token(term_value)
  ), term_candidates as (
    -- Keep compact model/item tokens such as "lp-140wfh", but do not turn
    -- decimals such as 15.6 into a misleading required token of 156.
    select regexp_replace(raw_term, '[^[:alnum:]]+', '', 'g') as term
    from raw_terms
    where raw_term !~ '[.,]'
    union
    select token.term_value as term
    from regexp_split_to_table(normalized_query, E'\\s+') as token(term_value)
  ), canonical_terms as (
    select case term
      when 'screens' then 'screen' when 'displays' then 'display' when 'panels' then 'panel'
      when 'batteries' then 'battery' when 'chargers' then 'charger' when 'keyboards' then 'keyboard'
      when 'adapters' then 'adapter' when 'cables' then 'cable' when 'monitors' then 'monitor'
      when 'laptops' then 'laptop' when 'desktops' then 'desktop' when 'mice' then 'mouse'
      when 'memories' then 'memory' when 'ssds' then 'ssd' when 'hdds' then 'hdd'
      else term end as term
    from term_candidates
  ), terms as (
    select distinct term
    from canonical_terms
    where char_length(term) >= 2
      and term not in (
        'a','an','the','what','which','where','when','who','how','do','does','did','we','you','i','me','my','our','your',
        'have','has','with','for','from','this','that','these','those','there','any','some','is','are','be','of','to','in','on',
        'stock','price','available','availability','inventory','need','want','show','find','search','give','please','check','look',
        'lookup','shop','store','pos','product','products','item','items','sell','carry','suitable','compatible','compatibility'
      )
  ), prepared as (
    select p.*,
      trim(regexp_replace(lower(coalesce(p.name, '')), '[^[:alnum:]]+', ' ', 'g')) as search_name,
      trim(regexp_replace(lower(coalesce(p.category_path, '')), '[^[:alnum:]]+', ' ', 'g')) as search_category,
      regexp_replace(lower(coalesce(p.item_code, '')), '[^[:alnum:]]+', '', 'g') as search_item_code,
      regexp_replace(lower(coalesce(p.barcode, '')), '[^[:alnum:]]+', '', 'g') as search_barcode
    from public.product_stock_view p
    where p.is_active
  ), ranked as (
    select p.*,
      term_match.matched_terms,
      term_match.numeric_term_count,
      term_match.matched_numeric_terms,
      term_totals.term_count,
      class_check.class_matches,
      term_match.term_score
        + case when p.search_item_code <> '' and p.search_item_code = compact_query then 260 else 0 end
        + case when p.search_barcode <> '' and p.search_barcode = compact_query then 250 else 0 end
        + case when p.search_name = normalized_query then 180 else 0 end
        + case when char_length(normalized_query) >= 3 and p.search_name like '%' || normalized_query || '%' then 95 else 0 end
        + case when term_totals.term_count > 1 and term_match.matched_terms = term_totals.term_count then 70 else 0 end as score,
      case
        when p.search_item_code <> '' and p.search_item_code = compact_query then 'exact_item_code'
        when p.search_barcode <> '' and p.search_barcode = compact_query then 'exact_barcode'
        when p.search_name = normalized_query then 'exact_name'
        when term_totals.term_count > 1 and term_match.matched_terms = term_totals.term_count then 'all_terms'
        else 'strict_relevant_terms'
      end as match_reason
    from prepared p
    cross join (select count(*)::integer as term_count from terms) term_totals
    cross join lateral (
      select
        count(*) filter (where
          p.search_item_code like '%' || t.term || '%'
          or p.search_barcode like '%' || t.term || '%'
          or p.search_name like '%' || t.term || '%'
          or p.search_category like '%' || t.term || '%'
        )::integer as matched_terms,
        count(*) filter (where t.term ~ '^[0-9]+$')::integer as numeric_term_count,
        count(*) filter (where t.term ~ '^[0-9]+$' and (
          p.search_item_code = t.term
          or p.search_barcode = t.term
          or (' ' || p.search_name || ' ') like '% ' || t.term || ' %'
          or (' ' || p.search_category || ' ') like '% ' || t.term || ' %'
        ))::integer as matched_numeric_terms,
        coalesce(sum(case
          when p.search_item_code = t.term then 180
          when p.search_barcode = t.term then 175
          when p.search_item_code like t.term || '%' then 80
          when p.search_barcode like t.term || '%' then 75
          when (' ' || p.search_name || ' ') like '% ' || t.term || ' %' then 38
          when p.search_name like '%' || t.term || '%' then 24
          when (' ' || p.search_category || ' ') like '% ' || t.term || ' %' then 12
          when p.search_category like '%' || t.term || '%' then 7
          else 0
        end), 0)::integer as term_score
      from terms t
    ) term_match
    cross join lateral (
      select case
        when exists (select 1 from terms where term in ('screen','display','lcd','panel'))
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(screens?|displays?|lcds?|panels?)( |$)'
        when exists (select 1 from terms where term = 'battery')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(battery|batteries)( |$)'
        when exists (select 1 from terms where term in ('charger','adapter'))
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(chargers?|adapters?|power supplies|power supply)( |$)'
        when exists (select 1 from terms where term = 'keyboard')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(keyboards?)( |$)'
        when exists (select 1 from terms where term in ('ram','memory'))
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(ram|memory)( |$)'
        when exists (select 1 from terms where term = 'ssd')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(ssds?|solid state)( |$)'
        when exists (select 1 from terms where term in ('hdd','harddrive'))
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(hdds?|hard drives?|harddrive)( |$)'
        when exists (select 1 from terms where term = 'cable')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(cables?)( |$)'
        when exists (select 1 from terms where term = 'mouse')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(mouse|mice)( |$)'
        when exists (select 1 from terms where term = 'monitor')
          then concat_ws(' ', p.search_name, p.search_category) ~ '(^| )(monitors?)( |$)'
        else true
      end as class_matches
    ) class_check
  ), limited as (
    select *
    from ranked
    where (
      (
        term_count > 0
        and class_matches
        and matched_numeric_terms = numeric_term_count
        and matched_terms >= case
          when term_count <= 2 then term_count
          when term_count <= 4 then 2
          else ceil(term_count::numeric * 0.60)::integer
        end
      )
      or (search_item_code <> '' and search_item_code = compact_query)
      or (search_barcode <> '' and search_barcode = compact_query)
      or (normalized_query <> '' and search_name = normalized_query)
    )
    order by score desc, matched_terms desc, available_qty desc nulls last, item_code
    limit 12
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', p.product_id,
    'item_code', p.item_code,
    'name', p.name,
    'category', p.category_path,
    'selling_price', p.selling_price,
    'average_cost', case when show_cost then p.avg_cost else null end,
    'track_inventory', p.track_inventory,
    'sellable_qty', p.sellable_qty,
    'reserved_qty', p.reserved_qty,
    'available_qty', p.available_qty,
    'in_transit_qty', p.in_transit_qty,
    'damaged_qty', p.damaged_qty,
    'warranty_months', p.warranty_months,
    'matched_terms', p.matched_terms,
    'match_reason', p.match_reason,
    'search_score', p.score
  ) order by p.score desc, p.matched_terms desc, p.available_qty desc nulls last, p.item_code), '[]'::jsonb)
  into products_json from limited p;

  -- Supplier-memory search remains broad because Gemini receives catalogue
  -- notes rather than displaying every row as a POS product suggestion.
  with terms as (
    select distinct regexp_replace(lower(token.term_value), '^[[:punct:]]+|[[:punct:]]+$', '', 'g') as term
    from regexp_split_to_table(clean_query, E'\\s+') as token(term_value)
    where char_length(regexp_replace(token.term_value, '^[[:punct:]]+|[[:punct:]]+$', '', 'g')) >= 2
  ), ranked as (
    select k.*,
      (select count(*) from terms t where lower(concat_ws(' ', k.supplier_name, k.title, array_to_string(k.tags, ' '), k.content)) like '%' || t.term || '%') as score
    from public.assistant_supplier_knowledge k
    where k.is_active
  ), limited as (
    select * from ranked where score > 0 order by score desc, updated_at desc limit 6
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', k.id,
    'supplier_name', k.supplier_name,
    'title', k.title,
    'content', left(k.content, 4000),
    'tags', k.tags,
    'updated_at', k.updated_at
  ) order by k.score desc, k.updated_at desc), '[]'::jsonb)
  into knowledge_json from limited k;

  return jsonb_build_object('products', products_json, 'supplier_knowledge', knowledge_json, 'checked_at', now());
end;
$$;

comment on function public.assistant_search_context_v45(text) is
  'Permission-gated assistant lookup requiring relevant term coverage, requested product class, and all numeric constraints.';

revoke all on function public.assistant_search_context_v45(text) from public;
grant execute on function public.assistant_search_context_v45(text) to authenticated;
