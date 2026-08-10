-- Permission-aware, read-only business context for the Gemini assistant.
-- Run once after migrations 038, 044 and 045.

begin;

update public.staff s
set permissions = jsonb_set(coalesce(s.permissions, '{}'::jsonb), '{assistant_business_data}', 'false'::jsonb, true),
    updated_at = now()
where s.role = 'staff'
  and not (coalesce(s.permissions, '{}'::jsonb) ? 'assistant_business_data');

create or replace function public.assistant_business_context_v48(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  clean_query text := left(trim(coalesce(p_query, '')), 500);
  requested_from date;
  requested_to date;
  iso_date_text text;
  slash_date_text text;
  customer_ids uuid[] := array[]::uuid[];
  supplier_ids uuid[] := array[]::uuid[];
  customers_json jsonb := '[]'::jsonb;
  suppliers_json jsonb := '[]'::jsonb;
  documents_json jsonb := '[]'::jsonb;
  summary_json jsonb := '{}'::jsonb;
  period_json jsonb := '{}'::jsonb;
  wants_documents boolean := false;
begin
  if coalesce(public.has_pos_permission_v38('use_ai_assistant'), false) is not true then
    raise exception 'The active user does not have Tech Assistant permission';
  end if;
  if coalesce(public.has_pos_permission_v38('assistant_business_data'), false) is not true then
    raise exception 'Business data permission is required for this question';
  end if;

  if clean_query = '' then return jsonb_build_object('checked_at', now()); end if;

  iso_date_text := substring(clean_query from '([0-9]{4}-[0-9]{2}-[0-9]{2})');
  slash_date_text := substring(clean_query from '([0-9]{1,2}/[0-9]{1,2}/[0-9]{4})');
  if iso_date_text is not null then
    requested_from := iso_date_text::date;
    requested_to := requested_from;
  elsif slash_date_text is not null then
    requested_from := to_date(slash_date_text, 'DD/MM/YYYY');
    requested_to := requested_from;
  elsif lower(clean_query) ~ '\m(yesterday)\M' then
    requested_from := current_date - 1;
    requested_to := current_date - 1;
  elsif lower(clean_query) ~ '\m(today|this day)\M' then
    requested_from := current_date;
    requested_to := current_date;
  elsif lower(clean_query) ~ '\mlast month\M' then
    requested_from := (date_trunc('month', current_date) - interval '1 month')::date;
    requested_to := (date_trunc('month', current_date) - interval '1 day')::date;
  elsif lower(clean_query) ~ '\mthis month\M' then
    requested_from := date_trunc('month', current_date)::date;
    requested_to := current_date;
  end if;

  wants_documents := lower(clean_query) ~ '(bought|buy|purchased|purchase|sale|sales|invoice|bill|document|transaction|payment|paid|today|yesterday|this day|this month|last month)';

  with terms as (
    select distinct regexp_replace(lower(t.term_value), '^[[:punct:]]+|[[:punct:]]+$', '', 'g') as term
    from regexp_split_to_table(clean_query, E'\\s+') as t(term_value)
    where char_length(regexp_replace(t.term_value, '^[[:punct:]]+|[[:punct:]]+$', '', 'g')) >= 2
      and lower(regexp_replace(t.term_value, '^[[:punct:]]+|[[:punct:]]+$', '', 'g')) not in (
        'what','which','who','where','when','how','did','does','do','has','have','had','was','were','is','are',
        'the','this','that','from','with','for','and','but','shop','customer','supplier','amount','balance','outstanding',
        'bought','buy','purchased','purchase','sale','sales','invoice','bill','document','transaction','payment','paid',
        'pay','owe','owes','owing','need','needs','today','yesterday','day','month','last','show','find','check','please'
      )
      and t.term_value !~ '^[0-9]{1,4}[-/]?[0-9]{0,2}[-/]?[0-9]{0,4}$'
  ), ranked as (
    select c.id,
      case when lower(c.name) = lower(clean_query) then 200
           when lower(clean_query) like '%' || lower(c.name) || '%' then 120
           else 10 * (select count(*) from terms x where lower(c.name) like '%' || x.term || '%') end as score
    from public.customers c
  )
  select coalesce(array_agg(r.id order by r.score desc), array[]::uuid[])
  into customer_ids
  from (select ranked.id, ranked.score from ranked where ranked.score > 0 order by ranked.score desc limit 8) r;

  with terms as (
    select distinct regexp_replace(lower(t.term_value), '^[[:punct:]]+|[[:punct:]]+$', '', 'g') as term
    from regexp_split_to_table(clean_query, E'\\s+') as t(term_value)
    where char_length(regexp_replace(t.term_value, '^[[:punct:]]+|[[:punct:]]+$', '', 'g')) >= 2
      and lower(regexp_replace(t.term_value, '^[[:punct:]]+|[[:punct:]]+$', '', 'g')) not in (
        'what','which','who','where','when','how','did','does','do','has','have','had','was','were','is','are',
        'the','this','that','from','with','for','and','but','shop','customer','supplier','amount','balance','outstanding',
        'bought','buy','purchased','purchase','sale','sales','invoice','bill','document','transaction','payment','paid',
        'pay','owe','owes','owing','need','needs','today','yesterday','day','month','last','show','find','check','please'
      )
      and t.term_value !~ '^[0-9]{1,4}[-/]?[0-9]{0,2}[-/]?[0-9]{0,4}$'
  ), ranked as (
    select s.id,
      case when lower(s.name) = lower(clean_query) then 200
           when lower(clean_query) like '%' || lower(s.name) || '%' then 120
           else 10 * (select count(*) from terms x where lower(s.name) like '%' || x.term || '%') end as score
    from public.suppliers s
  )
  select coalesce(array_agg(r.id order by r.score desc), array[]::uuid[])
  into supplier_ids
  from (select ranked.id, ranked.score from ranked where ranked.score > 0 order by ranked.score desc limit 8) r;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'due_balance', round(coalesce(c.due_balance, 0), 2),
    'store_credit_balance', round(coalesce(c.store_credit_balance, 0), 2),
    'net_outstanding', round(coalesce(c.due_balance, 0) - coalesce(c.store_credit_balance, 0), 2)
  ) order by c.name), '[]'::jsonb)
  into customers_json
  from public.customers c
  where c.id = any(customer_ids);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'payable_balance', round(coalesce(s.payable_balance, 0), 2)
  ) order by s.name), '[]'::jsonb)
  into suppliers_json
  from public.suppliers s
  where s.id = any(supplier_ids);

  if cardinality(customer_ids) > 0 or cardinality(supplier_ids) > 0 or requested_from is not null or wants_documents then
    with matched_documents as (
      select d.*
      from public.documents d
      where (
          (
            (cardinality(customer_ids) > 0 or cardinality(supplier_ids) > 0)
            and (
              (cardinality(customer_ids) > 0 and d.customer_id = any(customer_ids))
              or (cardinality(supplier_ids) > 0 and d.supplier_id = any(supplier_ids))
            )
          )
          or (
            cardinality(customer_ids) = 0 and cardinality(supplier_ids) = 0
            and requested_from is not null and d.document_date::date between requested_from and requested_to
          )
          or lower(d.document_no) like '%' || lower(clean_query) || '%'
          or (
            wants_documents and cardinality(customer_ids) = 0 and cardinality(supplier_ids) = 0 and requested_from is null
            and d.document_type in ('invoice','purchase','customer_payment','supplier_payment','refund','trade_in')
          )
        )
        and (requested_from is null or d.document_date::date between requested_from and requested_to)
      order by d.document_date desc, d.created_at desc
      limit 30
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id,
      'document_no', d.document_no,
      'document_type', d.document_type,
      'status', d.status,
      'document_date', d.document_date,
      'customer_id', d.customer_id,
      'supplier_id', d.supplier_id,
      'party_name', coalesce(c.name, s.name, d.recipient_name, 'Walk-in customer'),
      'total_amount', round(coalesce(d.total_amount, 0), 2),
      'paid_amount', round(coalesce(d.paid_amount, 0), 2),
      'balance_amount', round(coalesce(d.balance_amount, 0), 2),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'item_code', item_rows.item_code,
          'description', item_rows.description,
          'qty', item_rows.qty,
          'unit_price', item_rows.unit_price,
          'line_total', item_rows.line_total
        ) order by item_rows.created_at)
        from (
          select di.item_code, di.description, di.qty, di.unit_price, di.line_total, di.created_at
          from public.document_items di
          where di.document_id = d.id
          order by di.created_at
          limit 12
        ) item_rows
      ), '[]'::jsonb)
    ) order by d.document_date desc, d.created_at desc), '[]'::jsonb)
    into documents_json
    from matched_documents d
    left join public.customers c on c.id = d.customer_id
    left join public.suppliers s on s.id = d.supplier_id;
  end if;

  if cardinality(customer_ids) = 0 and cardinality(supplier_ids) = 0 then
    select jsonb_build_object(
    'currency', 'LKR',
    'customer_receivables', round(coalesce((select sum(greatest(coalesce(c.due_balance, 0) - coalesce(c.store_credit_balance, 0), 0)) from public.customers c), 0), 2),
    'customer_credit_owed', round(coalesce((select sum(greatest(coalesce(c.store_credit_balance, 0) - coalesce(c.due_balance, 0), 0)) from public.customers c), 0), 2),
    'supplier_payables', round(coalesce((select sum(greatest(coalesce(s.payable_balance, 0), 0)) from public.suppliers s), 0), 2),
    'unpaid_purchase_documents', round(coalesce((select sum(greatest(coalesce(d.balance_amount, 0), 0)) from public.documents d where d.document_type = 'purchase' and lower(coalesce(d.status, '')) not in ('cancelled','canceled','void','deleted')), 0), 2),
    'top_customer_receivables', coalesce((
      select jsonb_agg(jsonb_build_object('id', rows.id, 'name', rows.name, 'amount', round(rows.amount, 2)) order by rows.amount desc)
      from (
        select c.id, c.name, coalesce(c.due_balance, 0) - coalesce(c.store_credit_balance, 0) as amount
        from public.customers c
        where coalesce(c.due_balance, 0) - coalesce(c.store_credit_balance, 0) > 0
        order by amount desc
        limit 15
      ) rows
    ), '[]'::jsonb),
    'top_customer_credits', coalesce((
      select jsonb_agg(jsonb_build_object('id', rows.id, 'name', rows.name, 'amount', round(rows.amount, 2)) order by rows.amount desc)
      from (
        select c.id, c.name, coalesce(c.store_credit_balance, 0) - coalesce(c.due_balance, 0) as amount
        from public.customers c
        where coalesce(c.store_credit_balance, 0) - coalesce(c.due_balance, 0) > 0
        order by amount desc
        limit 15
      ) rows
    ), '[]'::jsonb),
    'top_supplier_payables', coalesce((
      select jsonb_agg(jsonb_build_object('id', rows.id, 'name', rows.name, 'payable_balance', round(rows.payable_balance, 2)) order by rows.payable_balance desc)
      from (
        select s.id, s.name, s.payable_balance
        from public.suppliers s
        where coalesce(s.payable_balance, 0) > 0
        order by s.payable_balance desc
        limit 10
      ) rows
    ), '[]'::jsonb)
    ) into summary_json;
  end if;

  if requested_from is not null and cardinality(customer_ids) = 0 and cardinality(supplier_ids) = 0 then
    select jsonb_build_object(
      'from', requested_from,
      'to', requested_to,
      'sales_documents', (select count(*) from public.documents d where d.document_type = 'invoice' and d.document_date::date between requested_from and requested_to and lower(coalesce(d.status, '')) not in ('cancelled','canceled','void','deleted')),
      'sales_total', round(coalesce((select sum(d.total_amount) from public.documents d where d.document_type = 'invoice' and d.document_date::date between requested_from and requested_to and lower(coalesce(d.status, '')) not in ('cancelled','canceled','void','deleted')), 0), 2),
      'purchase_documents', (select count(*) from public.documents d where d.document_type = 'purchase' and d.document_date::date between requested_from and requested_to and lower(coalesce(d.status, '')) not in ('cancelled','canceled','void','deleted')),
      'purchase_total', round(coalesce((select sum(abs(d.total_amount)) from public.documents d where d.document_type = 'purchase' and d.document_date::date between requested_from and requested_to and lower(coalesce(d.status, '')) not in ('cancelled','canceled','void','deleted')), 0), 2),
      'cash_in', round(coalesce((select sum(cf.amount) from public.cashflow_entries cf where cf.entry_type = 'cash_in' and cf.created_at::date between requested_from and requested_to), 0), 2),
      'cash_out', round(coalesce((select sum(cf.amount) from public.cashflow_entries cf where cf.entry_type = 'cash_out' and cf.created_at::date between requested_from and requested_to), 0), 2)
    ) into period_json;
  end if;

  return jsonb_build_object(
    'customers', customers_json,
    'suppliers', suppliers_json,
    'documents', documents_json,
    'financial_summary', summary_json,
    'period_summary', period_json,
    'requested_period', case when requested_from is null then null else jsonb_build_object('from', requested_from, 'to', requested_to) end,
    'checked_at', now()
  );
end;
$$;

-- Saved business answers remain hidden if this permission is later removed.
create or replace function public.assistant_list_conversations_v45()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_staff_id uuid := public.current_pos_staff_id_v38();
  retention_days integer;
  can_read_business boolean := coalesce(public.has_pos_permission_v38('assistant_business_data'), false);
  result jsonb;
begin
  if coalesce(public.has_pos_permission_v38('use_ai_assistant'), false) is not true then raise exception 'Tech Assistant permission required'; end if;
  select s.conversation_retention_days into retention_days from public.assistant_settings s where s.id = true;
  delete from public.assistant_conversations c
    where c.staff_id = current_staff_id and c.updated_at < now() - make_interval(days => coalesce(retention_days, 30));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'language', c.language,
    'created_at', c.created_at, 'updated_at', c.updated_at,
    'message_count', (select count(*) from public.assistant_messages m where m.conversation_id = c.id)
  ) order by c.updated_at desc), '[]'::jsonb)
  into result
  from public.assistant_conversations c
  where c.staff_id = current_staff_id
    and (can_read_business or not exists(
      select 1 from public.assistant_messages sensitive
      where sensitive.conversation_id = c.id and coalesce((sensitive.metadata ->> 'business_data')::boolean, false)
    ));
  return result;
end;
$$;

create or replace function public.assistant_get_conversation_v45(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  current_staff_id uuid := public.current_pos_staff_id_v38();
  result jsonb;
begin
  if coalesce(public.has_pos_permission_v38('use_ai_assistant'), false) is not true then raise exception 'Tech Assistant permission required'; end if;
  if not exists(select 1 from public.assistant_conversations c where c.id = p_conversation_id and c.staff_id = current_staff_id) then
    raise exception 'Conversation was not found';
  end if;
  if coalesce(public.has_pos_permission_v38('assistant_business_data'), false) is not true and exists(
    select 1 from public.assistant_messages m
    where m.conversation_id = p_conversation_id and coalesce((m.metadata ->> 'business_data')::boolean, false)
  ) then
    raise exception 'Business data permission is required to reopen this conversation';
  end if;
  select jsonb_build_object(
    'conversation', jsonb_build_object('id', c.id, 'title', c.title, 'language', c.language, 'updated_at', c.updated_at),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'role', m.role, 'text', m.content, 'metadata', m.metadata, 'created_at', m.created_at
    ) order by m.created_at, m.id) from public.assistant_messages m where m.conversation_id = c.id), '[]'::jsonb)
  ) into result
  from public.assistant_conversations c
  where c.id = p_conversation_id and c.staff_id = current_staff_id;
  return result;
end;
$$;

revoke all on function public.assistant_business_context_v48(text) from public;
grant execute on function public.assistant_business_context_v48(text) to authenticated;

commit;
