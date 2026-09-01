-- v59: Searchable, admin-managed POS staff handbook for the Tech Assistant.
-- Run once after 058_staff_document_attribution.sql, then redeploy tech-assistant.

begin;

create table if not exists public.assistant_pos_guides (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  area text not null default 'General',
  keywords text[] not null default '{}',
  content text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create unique index if not exists assistant_pos_guides_topic_key
  on public.assistant_pos_guides(lower(topic));

alter table public.assistant_pos_guides enable row level security;
revoke all on table public.assistant_pos_guides from anon, authenticated;

insert into public.assistant_pos_guides(topic, area, keywords, content) values
('Make a normal POS sale', 'POS', array['sale','invoice','bill','checkout','payment','cash','bank','credit'],
'1. Open POS. Search or browse Products and click each item to set quantity and selling price before adding it. 2. Select a named customer when the sale will carry credit, use an existing customer balance, or process a return; otherwise keep Walk-in customer. 3. Use Payment or a quick payment button and enter the payment lines. 4. Choose Save Sale. 5. After saving, choose Print A5 Invoice, Save PDF, WhatsApp, or Continue to New Sale. A walk-in sale must be fully paid.'),
('Return or exchange an item from an invoice', 'POS', array['return','exchange','exchange bill','refund','damaged','original invoice'],
'1. Open POS and choose Return in the Sale command row. 2. If this belongs to a named customer, select that customer first; otherwise the lookup shows walk-in invoices. 3. Search for and select the original invoice. 4. Tick the sold item, enter the return quantity, and optionally mark Damaged and add a reason. 5. Choose Add Return to POS for a refund/return, or Exchange Same Item to add both the negative return line and a replacement line. 6. Review the bill and payment/refund lines, then save. If the customer wants a different replacement product, first add the return to POS, close the lookup, then add the different product normally to the same bill. The resulting total determines whether money is collected, refunded, or no payment is needed.'),
('Find a customer previous selling price', 'POS', array['previous price','price history','sold before','regular customer','wholesale customer'],
'1. Select the named customer on POS. 2. Click the product you may add. 3. In the quantity and price popup, review the customer price history shown for that product. 4. Set the required price and quantity, then add it to the bill. Walk-in customer has no customer-specific price history.'),
('Open customer documents or profile from POS', 'POS', array['customer documents','customer profile','customer history','documents shortcut'],
'1. Select a named customer on POS. 2. Use Customer Docs beside the customer field to open Documents already filtered to that customer, or use Customer Profile to open the matching Customers & Suppliers profile. These shortcuts are disabled for Walk-in customer.'),
('Save and confirm an internal-review sale', 'POS', array['unconfirmed','review sale','draft sale','dummy sale','confirm sale'],
'1. Build the bill in POS normally. 2. Turn on Save for review before saving. 3. Save the document. It does not post stock, cashflow, customer balances, accounting, or reports, while the customer PDF still looks like a normal Sales Invoice. 4. Staff can find it in Documents under Unconfirmed Sale and edit or delete it. 5. An administrator selects it in Documents, chooses Confirm Sale, reviews it in POS, and saves to post the real sale. The review toggle resets for the next bill.'),
('Create and process a COD order', 'COD Orders', array['cod','cash on delivery','courier','dispatch','packing','settlement','placed by'],
'1. Open COD Orders and choose New Order. 2. Add recipient, contact, address, source, delivery settings, and products. The active PIN-unlocked staff member is recorded automatically as Placed by. 3. Save to reserve stock; this does not create a sale or cashflow yet. 4. Select the order in the queue. Use the top toolbar for Edit, Print Label, Print Bill, or Tracking. 5. Open Update / Workflow to mark Packed, Dispatched, Delivered/Awaiting Payment, Returned, or to record courier settlement. 6. Payment Received - Create Sale converts the COD order to a sales invoice and records the payment.'),
('Create and print a repair job', 'Jobs & Repairs', array['job','repair','device received','job receipt','device tag','mark ready'],
'1. Open Jobs & Repairs and choose New Job. 2. Select or add the customer, then enter device identification, reported problem, accessories received, estimate, and notes. 3. Save the job. 4. Select it to update its workflow from Received to Checking, Waiting for parts, Ready, or Completed. 5. Use Print Job Receipt for the landscape customer document, Save PDF for a file, or Print Device Tag for the thermal job label.'),
('Create and convert a quotation', 'Documents', array['quote','quotation','convert quote','estimate'],
'1. Open Documents, choose Add, then Quotation. 2. Select the customer, add products and prices, then save. 3. Later select the quotation in Documents and choose Convert Quote to Sales. 4. It opens in POS; add payment details, review, and save the invoice. The quotation remains linked as converted.'),
('Record customer or supplier payments', 'Customers & Suppliers', array['receive payment','refund customer','pay supplier','outstanding','credit balance'],
'1. Open Customers & Suppliers and select the profile. 2. Review whether the signed balance is receivable from the customer, refundable to the customer, or payable to the supplier. 3. Use the payment action shown for that balance, choose the payment method, and save. Use POS payment lines only for the current bill; use the party profile for payments against older outstanding balances.'),
('Record a cheque payment', 'Payments', array['cheque','check payment','cheque date','bank cheque'],
'Choose the Cheque payment method wherever it is available in POS, purchases, or customer/supplier payments. Enter the cheque number, cheque date, and bank name when requested. Cheque payments are recorded as bank activity and remain identifiable by their date and reference.'),
('Create purchase and stock in transit documents', 'Documents', array['purchase','stock in transit','receive stock','supplier','inventory document'],
'1. Open Documents and choose Add, then Purchase or Stock in Transit. 2. Select a supplier/customer profile, add products, quantities, costs, payment details, and cheque details when applicable. 3. Save the document. A purchase can apply stock according to its workflow; Stock in Transit records incoming stock without making it sellable. 4. Select an in-transit document and use Convert to Purchase when the stock arrives.'),
('Print, save, or WhatsApp a sales document', 'Documents', array['print bill','print invoice','pdf','whatsapp invoice','share bill'],
'Immediately after a POS sale, use Print A5 Invoice, Save PDF, or WhatsApp in the success window. For an older document, open Documents, select the row, then use Print, Print Preview, Save as PDF, or WhatsApp in the top toolbar. On desktop, WhatsApp opens and the PDF downloads so staff can attach it to the chosen chat.'),
('Open and close the daily register', 'Cashflow', array['daily register','cash drawer','opening cash','closing cash','cash count','variance'],
'Open Cashflow and use the daily register section for the current device. Enter the opening cash count at the start of the shift. At closing, enter the actual counted cash and close the register; the system compares it with expected cash activity and records any variance. Cheque and bank movements remain separate from physical cash.' )
on conflict ((lower(topic))) do update set
  area = excluded.area,
  keywords = excluded.keywords,
  content = excluded.content,
  is_active = true,
  updated_at = now();

create or replace function public.assistant_search_pos_guides_v59(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.has_pos_permission_v38('use_ai_assistant') then raise exception 'Tech Assistant permission required'; end if;
  with query_words as (
    select distinct lower(word) as word
    from regexp_split_to_table(regexp_replace(coalesce(p_query, ''), '[^[:alnum:] ]', ' ', 'g'), '\s+') word
    where length(word) >= 3
  ), ranked as (
    select g.*,
      (select count(*) from query_words q where
        lower(g.topic || ' ' || g.area || ' ' || array_to_string(g.keywords, ' ') || ' ' || g.content) like '%' || q.word || '%'
      ) as match_count
    from public.assistant_pos_guides g
    where g.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'topic', r.topic, 'area', r.area, 'keywords', r.keywords,
    'content', r.content, 'updated_at', r.updated_at
  ) order by r.match_count desc, r.topic) filter (where r.match_count > 0), '[]'::jsonb)
  into result
  from (select * from ranked where match_count > 0 order by match_count desc, topic limit 5) r;
  return result;
end;
$$;

create or replace function public.admin_list_pos_guides_v59()
returns setof public.assistant_pos_guides
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.assistant_is_admin_v45() then raise exception 'Only an active admin can manage POS staff guides'; end if;
  return query select * from public.assistant_pos_guides order by area, topic;
end;
$$;

create or replace function public.admin_save_pos_guide_v59(p_entry jsonb)
returns public.assistant_pos_guides
language plpgsql
security definer
set search_path = public
as $$
declare entry_id uuid := nullif(p_entry ->> 'id', '')::uuid;
declare saved public.assistant_pos_guides;
begin
  if not public.assistant_is_admin_v45() then raise exception 'Only an active admin can manage POS staff guides'; end if;
  if length(trim(coalesce(p_entry ->> 'topic', ''))) < 3 then raise exception 'Guide topic is required'; end if;
  if length(trim(coalesce(p_entry ->> 'content', ''))) < 20 then raise exception 'Guide instructions are too short'; end if;
  if entry_id is null then
    if (select count(*) from public.assistant_pos_guides) >= 100 then raise exception 'Maximum 100 POS staff guides'; end if;
    insert into public.assistant_pos_guides(topic, area, keywords, content, is_active, updated_by)
    values(
      left(trim(p_entry ->> 'topic'), 160), left(coalesce(nullif(trim(p_entry ->> 'area'), ''), 'General'), 80),
      coalesce(array(select left(trim(value), 60) from jsonb_array_elements_text(coalesce(p_entry -> 'keywords', '[]'::jsonb)) value where trim(value) <> '' limit 30), '{}'),
      left(trim(p_entry ->> 'content'), 12000), coalesce((p_entry ->> 'is_active')::boolean, true), auth.uid()
    ) returning * into saved;
  else
    update public.assistant_pos_guides set
      topic = left(trim(p_entry ->> 'topic'), 160), area = left(coalesce(nullif(trim(p_entry ->> 'area'), ''), 'General'), 80),
      keywords = coalesce(array(select left(trim(value), 60) from jsonb_array_elements_text(coalesce(p_entry -> 'keywords', '[]'::jsonb)) value where trim(value) <> '' limit 30), '{}'),
      content = left(trim(p_entry ->> 'content'), 12000), is_active = coalesce((p_entry ->> 'is_active')::boolean, true),
      updated_at = now(), updated_by = auth.uid()
    where id = entry_id returning * into saved;
    if saved.id is null then raise exception 'POS staff guide was not found'; end if;
  end if;
  return saved;
end;
$$;

create or replace function public.admin_delete_pos_guide_v59(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.assistant_is_admin_v45() then raise exception 'Only an active admin can manage POS staff guides'; end if;
  delete from public.assistant_pos_guides where id = p_entry_id;
end;
$$;

revoke all on function public.assistant_search_pos_guides_v59(text) from public;
revoke all on function public.admin_list_pos_guides_v59() from public;
revoke all on function public.admin_save_pos_guide_v59(jsonb) from public;
revoke all on function public.admin_delete_pos_guide_v59(uuid) from public;
grant execute on function public.assistant_search_pos_guides_v59(text) to authenticated;
grant execute on function public.admin_list_pos_guides_v59() to authenticated;
grant execute on function public.admin_save_pos_guide_v59(jsonb) to authenticated;
grant execute on function public.admin_delete_pos_guide_v59(uuid) to authenticated;

do $$
begin
  if not exists(
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assistant_pos_guides'
  ) then alter publication supabase_realtime add table public.assistant_pos_guides; end if;
end $$;

notify pgrst, 'reload schema';
commit;
