-- Enable live multi-device refreshes for shared POS business data.
-- Run once in the Supabase SQL editor after migrations 001-039.

do $$
declare
  table_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase Realtime publication was not found';
  end if;

  foreach table_name in array array[
    'documents',
    'document_items',
    'customers',
    'suppliers',
    'products',
    'stock_balances',
    'stock_movements',
    'categories',
    'brands',
    'payment_methods',
    'cashflow_entries',
    'company_settings',
    'product_assemblies',
    'product_assembly_items',
    'warranty_records',
    'warranty_claims',
    'warranty_claim_events'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = table_name
       ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;

comment on publication supabase_realtime is
  'Supabase Realtime publication, including Shop POS live business tables.';
