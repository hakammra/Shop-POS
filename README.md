# Computer Shop POS - v12 Collapsible Trees + Live Search

Replace these files in your current project:

- `src/App.jsx`
- `src/styles.css`
- `README.md`
- `supabase/sql/012_collapsible_tree_live_search_no_sql_needed.sql`

## Supabase

No SQL update is required for v12. The included SQL file is only a note.

## What changed

- Product/category trees are now collapsible.
- By default only the first level of category folders is shown.
- Click `+` / `-` to expand or minimize categories.
- Document product picker also uses collapsible category folders.
- Products and Stock pages now live-search automatically while typing.
- When live search is active, it searches all products and ignores selected category.
- When you click a category, the typed search text is kept but ignored, and category filtering becomes active again.
- Clicking inside the search box alone does not change the filter; only editing the text changes it.

## Gemini Tech Assistant

The Tech Assistant page calls Gemini through the `tech-assistant` Supabase Edge Function. The API key is never stored in the browser bundle.

1. Run `supabase/sql/044_tech_assistant_permission.sql` and then `supabase/sql/045_ai_memory_pos_tools_voice.sql` in the Supabase SQL Editor.
2. Create a Gemini API key in Google AI Studio.
3. Store it as an Edge Function secret: `npx supabase secrets set GEMINI_API_KEY=YOUR_KEY`.
4. Optional model override: `npx supabase secrets set GEMINI_MODEL=gemini-3.5-flash`.
5. Deploy: `npx supabase functions deploy tech-assistant`.

Existing staff receive the assistant permission when migration 044 is applied. Administrators can enable or disable it later from Settings, Users & Security.

Migration 045 adds safe read-only product/stock lookup, admin-reviewed supplier memory, English/Tamil answer preferences, browser voice input and playback, and bounded text conversation history. By default each staff member keeps at most 10 conversations for 30 days and each conversation is trimmed to 30 messages. Supplier-list images are sent to Gemini for extraction but are not stored by the app; an admin reviews the extracted text before saving it.

Product and supplier results are only queried when the question explicitly asks for shop stock, price, products or supplier-list information. Video requests return specific clickable YouTube searches; direct video URLs are not invented when live search is unavailable. Read aloud is a toggle, so the same button stops the current answer.

Run `supabase/sql/048_assistant_business_data.sql` after migration 045, then redeploy the `tech-assistant` Edge Function to add read-only business questions. Administrators automatically have access. Staff require the separate **Allow AI to read customer, supplier and financial data** permission. The assistant can then look up matching customer purchases, documents, customer balances, supplier payables and operational totals. Contact details are not sent to Gemini, the assistant cannot edit records, and saved business conversations are hidden automatically if the permission is later removed.

## Online storefront

Run `supabase/sql/046_online_storefront.sql` in the Supabase SQL Editor after migration 045. It creates the public catalogue API, separate website-content tables and the public product-image bucket.

Run `supabase/sql/047_online_store_orders.sql` after migration 046 to connect storefront checkout to the POS Online Orders page. A website submission is stored as an order request only; it does not create a sale, cashflow entry, COD order, or stock movement until a later confirmation/conversion workflow is added.

Run `supabase/sql/049_store_category_sync.sql` to add any POS categories created after the original storefront migration. It also keeps future POS categories synchronized automatically. The public category menus use the full POS hierarchy, for example `Accessories › Mouse › Mouses`.

- Public shop: `/store`
- Store administration: `/store/admin`
- Admin login: the email and password linked to the active POS administrator. Staff PINs cannot open Store Admin.

The POS remains the source of truth for item code, selling price, stock and warranty. Website names, descriptions, images, badges, category presentation and published status are stored separately. Existing active products are published during the first migration; products added later must be reviewed and published in Store Admin.

Checkout creates an Online Order request for staff review but does not charge the customer, create a sale, change cashflow or reserve stock.

## Start Fresh reset

Run `supabase/sql/050_admin_start_fresh.sql` after migration 049. It adds an administrator-only reset under **Settings → Backups & Restore → Start Fresh**.

The reset requires the exact phrase `RESET SHOP DATA` and creates a manual safety backup before it clears products, stock, customers, suppliers, documents, cashflow, warranties, online orders, accounting activity and saved assistant conversations. It preserves staff/admin accounts, PINs, trusted devices, permissions, company/application/printing settings, payment methods, online-store settings and assistant supplier knowledge. At least one active administrator must remain.

Uploaded storefront image files are retained in Supabase Storage so the safety backup can restore their product links. Remove orphaned files separately only after the reset has been checked and the safety backup is no longer needed.
