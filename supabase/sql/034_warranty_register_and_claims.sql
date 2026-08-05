-- v34: Product warranty register, claims, and replacement serial history.
-- Run once after 033_inventory_documents_cod_delete.sql.

create extension if not exists pgcrypto;

create sequence if not exists public.warranty_record_number_seq;
create sequence if not exists public.warranty_claim_number_seq;

create table if not exists public.warranty_records (
  id uuid primary key default gen_random_uuid(),
  warranty_no text not null unique,
  sale_document_id uuid not null references public.documents(id) on delete restrict,
  sale_document_item_id uuid not null references public.document_items(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  serial_number text,
  warranty_start date not null,
  warranty_end date not null,
  warranty_months integer not null check (warranty_months > 0),
  status text not null default 'active'
    check (status in ('active', 'claim_open', 'replaced', 'expired', 'void')),
  replaces_warranty_record_id uuid references public.warranty_records(id) on delete set null,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists warranty_records_serial_unique_idx
  on public.warranty_records (lower(trim(serial_number)))
  where serial_number is not null and trim(serial_number) <> '';
create index if not exists warranty_records_sale_document_idx on public.warranty_records(sale_document_id);
create index if not exists warranty_records_product_idx on public.warranty_records(product_id);
create index if not exists warranty_records_customer_idx on public.warranty_records(customer_id);

create table if not exists public.warranty_claims (
  id uuid primary key default gen_random_uuid(),
  claim_no text not null unique,
  warranty_record_id uuid not null references public.warranty_records(id) on delete restrict,
  status text not null default 'received'
    check (status in ('received', 'checking', 'sent_supplier', 'ready', 'repaired', 'replaced', 'rejected', 'completed')),
  issue text not null,
  received_condition text,
  resolution text,
  internal_notes text,
  original_warranty_end date not null,
  replacement_product_id uuid references public.products(id) on delete set null,
  replacement_serial_number text,
  replacement_warranty_record_id uuid references public.warranty_records(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists warranty_claims_record_idx on public.warranty_claims(warranty_record_id);
create index if not exists warranty_claims_status_idx on public.warranty_claims(status, created_at desc);

create table if not exists public.warranty_claim_events (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.warranty_claims(id) on delete cascade,
  status text not null,
  note text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists warranty_claim_events_claim_idx on public.warranty_claim_events(claim_id, created_at);

-- Warranty rows belong to the original sale. Cascades are required so the
-- existing all-or-nothing app restore can clear and rebuild its snapshot.
alter table public.warranty_records drop constraint if exists warranty_records_sale_document_id_fkey;
alter table public.warranty_records add constraint warranty_records_sale_document_id_fkey
  foreign key (sale_document_id) references public.documents(id) on delete cascade;
alter table public.warranty_records drop constraint if exists warranty_records_sale_document_item_id_fkey;
alter table public.warranty_records add constraint warranty_records_sale_document_item_id_fkey
  foreign key (sale_document_item_id) references public.document_items(id) on delete cascade;
alter table public.warranty_claims drop constraint if exists warranty_claims_warranty_record_id_fkey;
alter table public.warranty_claims add constraint warranty_claims_warranty_record_id_fkey
  foreign key (warranty_record_id) references public.warranty_records(id) on delete cascade;

alter table public.warranty_records enable row level security;
alter table public.warranty_claims enable row level security;
alter table public.warranty_claim_events enable row level security;

drop policy if exists "authenticated read warranty records" on public.warranty_records;
create policy "authenticated read warranty records" on public.warranty_records
  for select to authenticated using (true);
drop policy if exists "authenticated read warranty claims" on public.warranty_claims;
create policy "authenticated read warranty claims" on public.warranty_claims
  for select to authenticated using (true);
drop policy if exists "authenticated read warranty claim events" on public.warranty_claim_events;
create policy "authenticated read warranty claim events" on public.warranty_claim_events
  for select to authenticated using (true);

revoke insert, update, delete on public.warranty_records from authenticated;
revoke insert, update, delete on public.warranty_claims from authenticated;
revoke insert, update, delete on public.warranty_claim_events from authenticated;
grant select on public.warranty_records, public.warranty_claims, public.warranty_claim_events to authenticated;

create or replace function public.next_warranty_number_v34(p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  sequence_value bigint;
  prefix text;
begin
  if lower(trim(coalesce(p_kind, 'warranty'))) = 'claim' then
    sequence_value := nextval('public.warranty_claim_number_seq');
    prefix := 'WCL';
  else
    sequence_value := nextval('public.warranty_record_number_seq');
    prefix := 'WAR';
  end if;
  return prefix || '-' || to_char(timezone('Asia/Colombo', now()), 'YY') || '-' || lpad(sequence_value::text, 5, '0');
end;
$$;

create or replace function public.register_product_warranty_v34(
  p_sale_document_item_id uuid,
  p_serial_number text default null,
  p_warranty_months integer default null,
  p_warranty_start date default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_row record;
  months_value integer;
  start_value date;
  end_value date;
  serial_value text := nullif(upper(trim(coalesce(p_serial_number, ''))), '');
  registered_count integer;
  warranty_id uuid;
  warranty_number text;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;

  select di.*, d.document_no, d.document_date, d.customer_id, d.document_type,
         p.warranty_months as product_warranty_months, p.serial_required
  into sale_row
  from public.document_items di
  join public.documents d on d.id = di.document_id
  join public.products p on p.id = di.product_id
  where di.id = p_sale_document_item_id
  for update of di;

  if not found then raise exception 'Sale item not found'; end if;
  if sale_row.document_type <> 'invoice' or sale_row.qty <= 0 then
    raise exception 'Warranty registration requires a sold invoice item';
  end if;
  if sale_row.serial_required and serial_value is null then
    raise exception 'A serial number is required for this product';
  end if;

  select count(*) into registered_count
  from public.warranty_records
  where sale_document_item_id = p_sale_document_item_id
    and replaces_warranty_record_id is null
    and status <> 'void';
  if registered_count >= floor(sale_row.qty) then
    raise exception 'All sold units on this invoice line already have warranty records';
  end if;

  months_value := coalesce(p_warranty_months, sale_row.product_warranty_months, 0);
  if months_value <= 0 then raise exception 'Warranty period must be greater than zero months'; end if;
  start_value := coalesce(p_warranty_start, sale_row.document_date::date);
  end_value := (start_value + make_interval(months => months_value) - interval '1 day')::date;
  warranty_number := public.next_warranty_number_v34('warranty');

  insert into public.warranty_records (
    warranty_no, sale_document_id, sale_document_item_id, product_id, customer_id,
    serial_number, warranty_start, warranty_end, warranty_months, notes
  ) values (
    warranty_number, sale_row.document_id, sale_row.id, sale_row.product_id, sale_row.customer_id,
    serial_value, start_value, end_value, months_value, nullif(trim(coalesce(p_notes, '')), '')
  ) returning id into warranty_id;

  return jsonb_build_object('id', warranty_id, 'warranty_no', warranty_number, 'warranty_end', end_value);
end;
$$;

create or replace function public.create_warranty_claim_v34(
  p_warranty_record_id uuid,
  p_issue text,
  p_received_condition text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  warranty_row public.warranty_records%rowtype;
  claim_id uuid;
  claim_number text;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if trim(coalesce(p_issue, '')) = '' then raise exception 'Describe the reported issue'; end if;

  select * into warranty_row from public.warranty_records where id = p_warranty_record_id for update;
  if not found then raise exception 'Warranty record not found'; end if;
  if warranty_row.status in ('replaced', 'void') then raise exception 'This warranty record cannot accept a new claim'; end if;
  if warranty_row.warranty_end < current_date then
    update public.warranty_records set status = 'expired', updated_at = now() where id = warranty_row.id;
    raise exception 'Warranty expired on %', warranty_row.warranty_end;
  end if;
  if exists (
    select 1 from public.warranty_claims
    where warranty_record_id = warranty_row.id and status in ('received', 'checking', 'sent_supplier', 'ready')
  ) then raise exception 'This warranty already has an open claim'; end if;

  claim_number := public.next_warranty_number_v34('claim');
  insert into public.warranty_claims (
    claim_no, warranty_record_id, issue, received_condition, internal_notes, original_warranty_end
  ) values (
    claim_number, warranty_row.id, trim(p_issue), nullif(trim(coalesce(p_received_condition, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''), warranty_row.warranty_end
  ) returning id into claim_id;

  update public.warranty_records set status = 'claim_open', updated_at = now() where id = warranty_row.id;
  insert into public.warranty_claim_events (claim_id, status, note)
  values (claim_id, 'received', 'Warranty item received');

  return jsonb_build_object('id', claim_id, 'claim_no', claim_number);
end;
$$;

create or replace function public.update_warranty_claim_v34(
  p_claim_id uuid,
  p_status text,
  p_resolution text default null,
  p_notes text default null,
  p_replacement_product_id uuid default null,
  p_replacement_serial_number text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.warranty_claims%rowtype;
  warranty_row public.warranty_records%rowtype;
  replacement_product public.products%rowtype;
  clean_status text := lower(trim(coalesce(p_status, '')));
  clean_serial text := nullif(upper(trim(coalesce(p_replacement_serial_number, ''))), '');
  replacement_id uuid;
  replacement_no text;
  is_closed boolean;
begin
  if auth.uid() is null then raise exception 'You must be signed in'; end if;
  if clean_status not in ('received', 'checking', 'sent_supplier', 'ready', 'repaired', 'replaced', 'rejected', 'completed') then
    raise exception 'Unsupported warranty claim status';
  end if;

  select * into claim_row from public.warranty_claims where id = p_claim_id for update;
  if not found then raise exception 'Warranty claim not found'; end if;
  select * into warranty_row from public.warranty_records where id = claim_row.warranty_record_id for update;

  if claim_row.replacement_warranty_record_id is not null
     and clean_status not in ('replaced', 'completed') then
    raise exception 'A replaced claim can only remain Replaced or be marked Completed';
  end if;

  replacement_id := claim_row.replacement_warranty_record_id;
  if clean_status = 'replaced' and replacement_id is null then
    if p_replacement_product_id is null then raise exception 'Select the replacement product'; end if;
    select * into replacement_product from public.products where id = p_replacement_product_id;
    if not found then raise exception 'Replacement product not found'; end if;
    if replacement_product.serial_required and clean_serial is null then raise exception 'Replacement serial number is required'; end if;
    replacement_no := public.next_warranty_number_v34('warranty');
    insert into public.warranty_records (
      warranty_no, sale_document_id, sale_document_item_id, product_id, customer_id,
      serial_number, warranty_start, warranty_end, warranty_months, status,
      replaces_warranty_record_id, notes
    ) values (
      replacement_no, warranty_row.sale_document_id, warranty_row.sale_document_item_id,
      replacement_product.id, warranty_row.customer_id, clean_serial,
      warranty_row.warranty_start, warranty_row.warranty_end, warranty_row.warranty_months,
      'active', warranty_row.id, 'Replacement under claim ' || claim_row.claim_no
    ) returning id into replacement_id;
    update public.warranty_records set status = 'replaced', updated_at = now() where id = warranty_row.id;
  elsif clean_status in ('repaired', 'rejected', 'completed') and warranty_row.status <> 'replaced' then
    update public.warranty_records set status = case when warranty_end < current_date then 'expired' else 'active' end, updated_at = now() where id = warranty_row.id;
  elsif clean_status in ('received', 'checking', 'sent_supplier', 'ready') then
    update public.warranty_records set status = 'claim_open', updated_at = now() where id = warranty_row.id;
  end if;

  is_closed := clean_status in ('repaired', 'replaced', 'rejected', 'completed');
  update public.warranty_claims
  set status = clean_status,
      resolution = nullif(trim(coalesce(p_resolution, resolution, '')), ''),
      internal_notes = nullif(trim(coalesce(p_notes, internal_notes, '')), ''),
      replacement_product_id = case when clean_status = 'replaced' then p_replacement_product_id else replacement_product_id end,
      replacement_serial_number = case when clean_status = 'replaced' then clean_serial else replacement_serial_number end,
      replacement_warranty_record_id = coalesce(replacement_id, replacement_warranty_record_id),
      closed_at = case when is_closed then coalesce(closed_at, now()) else null end,
      updated_at = now()
  where id = claim_row.id;

  insert into public.warranty_claim_events (claim_id, status, note)
  values (claim_row.id, clean_status, coalesce(nullif(trim(coalesce(p_notes, '')), ''), nullif(trim(coalesce(p_resolution, '')), '')));

  return jsonb_build_object('id', claim_row.id, 'claim_no', claim_row.claim_no, 'status', clean_status, 'replacement_warranty_record_id', replacement_id);
end;
$$;

drop view if exists public.warranty_register_view;
create view public.warranty_register_view
with (security_invoker = true)
as
select
  wr.*,
  d.document_no,
  d.document_date,
  di.item_code,
  di.description as sold_description,
  di.qty as sold_line_qty,
  p.name as product_name,
  p.item_code as product_code,
  p.serial_required,
  c.name as customer_name,
  c.phone as customer_phone,
  replacing.warranty_no as replaces_warranty_no,
  case when wr.warranty_end < current_date and wr.status = 'active' then 'expired' else wr.status end as display_status
from public.warranty_records wr
join public.documents d on d.id = wr.sale_document_id
join public.document_items di on di.id = wr.sale_document_item_id
join public.products p on p.id = wr.product_id
left join public.customers c on c.id = wr.customer_id
left join public.warranty_records replacing on replacing.id = wr.replaces_warranty_record_id;

drop view if exists public.warranty_claims_view;
create view public.warranty_claims_view
with (security_invoker = true)
as
select
  wc.*,
  wr.warranty_no,
  wr.serial_number,
  wr.warranty_start,
  wr.warranty_end,
  wr.product_id,
  wr.customer_id,
  d.document_no,
  d.document_date,
  p.item_code as product_code,
  p.name as product_name,
  c.name as customer_name,
  c.phone as customer_phone,
  rp.item_code as replacement_product_code,
  rp.name as replacement_product_name,
  rwr.warranty_no as replacement_warranty_no
from public.warranty_claims wc
join public.warranty_records wr on wr.id = wc.warranty_record_id
join public.documents d on d.id = wr.sale_document_id
join public.products p on p.id = wr.product_id
left join public.customers c on c.id = wr.customer_id
left join public.products rp on rp.id = wc.replacement_product_id
left join public.warranty_records rwr on rwr.id = wc.replacement_warranty_record_id;

grant select on public.warranty_register_view, public.warranty_claims_view to authenticated;
revoke all on function public.next_warranty_number_v34(text) from public;
revoke all on function public.register_product_warranty_v34(uuid, text, integer, date, text) from public;
revoke all on function public.create_warranty_claim_v34(uuid, text, text, text) from public;
revoke all on function public.update_warranty_claim_v34(uuid, text, text, text, uuid, text) from public;
grant execute on function public.register_product_warranty_v34(uuid, text, integer, date, text) to authenticated;
grant execute on function public.create_warranty_claim_v34(uuid, text, text, text) to authenticated;
grant execute on function public.update_warranty_claim_v34(uuid, text, text, text, uuid, text) to authenticated;

-- Extend the v31 logical app backup without replacing its large transactional
-- backup/restore functions. Every new snapshot receives warranty data. During
-- restore, the existing function updates the chosen backup to "restored" only
-- after products, parties, documents, and items have been rebuilt; this trigger
-- then restores the dependent warranty rows in the correct order.
create or replace function public.add_warranty_to_app_backup_v34()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object(
    'warranty_records', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.warranty_records x), '[]'::jsonb),
    'warranty_claims', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.warranty_claims x), '[]'::jsonb),
    'warranty_claim_events', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.warranty_claim_events x), '[]'::jsonb)
  );
  new.row_counts := coalesce(new.row_counts, '{}'::jsonb) || jsonb_build_object(
    'warranties', (select count(*) from public.warranty_records),
    'warranty_claims', (select count(*) from public.warranty_claims)
  );
  new.schema_version := greatest(coalesce(new.schema_version, 1), 34);
  new.snapshot_size_bytes := pg_column_size(new.snapshot);
  return new;
end;
$$;

drop trigger if exists add_warranty_to_app_backup_v34_trigger on public.app_backups;
create trigger add_warranty_to_app_backup_v34_trigger
before insert or update of snapshot on public.app_backups
for each row execute function public.add_warranty_to_app_backup_v34();

create or replace function public.restore_warranty_from_app_backup_v34()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'restored' and current_setting('shop_pos.restore_mode', true) = 'on' then
    insert into public.warranty_records
    select * from jsonb_populate_recordset(null::public.warranty_records, coalesce(new.snapshot -> 'warranty_records', '[]'::jsonb));
    insert into public.warranty_claims
    select * from jsonb_populate_recordset(null::public.warranty_claims, coalesce(new.snapshot -> 'warranty_claims', '[]'::jsonb));
    insert into public.warranty_claim_events
    select * from jsonb_populate_recordset(null::public.warranty_claim_events, coalesce(new.snapshot -> 'warranty_claim_events', '[]'::jsonb));
  end if;
  return new;
end;
$$;

drop trigger if exists restore_warranty_from_app_backup_v34_trigger on public.app_backups;
create trigger restore_warranty_from_app_backup_v34_trigger
after update of status on public.app_backups
for each row execute function public.restore_warranty_from_app_backup_v34();

-- Expose the existing product warranty defaults to Products, POS, and document pickers.
create or replace view public.product_stock_view
with (security_invoker = true)
as
select
  p.id as product_id,
  p.item_code,
  p.name,
  p.category_id,
  p.barcode,
  p.selling_price,
  p.avg_cost,
  case when coalesce(p.avg_cost, 0) <= 0 then 0
       else round(((coalesce(p.selling_price, 0) - coalesce(p.avg_cost, 0)) / nullif(p.avg_cost, 0)) * 100, 2)
  end as markup_percent,
  p.min_stock_level,
  p.online_visible,
  p.is_active,
  p.status,
  c.name as category_name,
  c.path as category_path,
  c.parent_id as category_parent_id,
  b.name as brand_name,
  coalesce(s.sellable_qty, 0) as sellable_qty,
  coalesce(s.sellable_qty, 0) as quantity,
  coalesce(s.reserved_qty, 0) as reserved_qty,
  coalesce(s.damaged_qty, 0) as damaged_qty,
  coalesce(s.checking_qty, 0) as checking_qty,
  coalesce(s.sellable_qty, 0) - coalesce(s.reserved_qty, 0) as available_qty,
  coalesce(s.in_transit_qty, 0) as in_transit_qty,
  (coalesce(s.sellable_qty, 0) * coalesce(p.avg_cost, 0)) as total_cost_value,
  (coalesce(s.sellable_qty, 0) * coalesce(p.selling_price, 0)) as total_sale_value,
  (coalesce(s.in_transit_qty, 0) * coalesce(p.avg_cost, 0)) as in_transit_value,
  (coalesce(s.sellable_qty, 0) <= coalesce(p.min_stock_level, 1)) as is_low_stock,
  -- New view columns must be appended so CREATE OR REPLACE remains compatible
  -- with clients and database objects that already depend on the v4 column order.
  p.warranty_months,
  p.serial_required
from public.products p
left join public.categories c on c.id = p.category_id
left join public.brands b on b.id = p.brand_id
left join public.stock_balances s on s.product_id = p.id;

grant select on public.product_stock_view to authenticated;
notify pgrst, 'reload schema';
