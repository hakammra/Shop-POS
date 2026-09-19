-- Fix Wholesale checkout fingerprints on Supabase projects where pgcrypto is
-- installed in the extensions schema. Run after 076_retail_wholesale_bridge.sql.

begin;

create extension if not exists pgcrypto with schema extensions;

-- The v76 function deliberately used a restricted search_path, but that also
-- hid extensions.digest(text, text) at runtime.
alter function public.prepare_retail_wholesale_transfer_v76(uuid, jsonb)
  set search_path = public, extensions;

notify pgrst, 'reload schema';

commit;
