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
   For lower free-tier demand, use `npx supabase secrets set GEMINI_MODEL=gemini-3.5-flash-lite`. The function automatically retries `429` and `503` failures once with `GEMINI_FALLBACK_MODEL`, which defaults to `gemini-3.5-flash-lite`; override it with `npx supabase secrets set GEMINI_FALLBACK_MODEL=MODEL_ID` if needed.
5. Deploy: `npx supabase functions deploy tech-assistant`.

Existing staff receive the assistant permission when migration 044 is applied. Administrators can enable or disable it later from Settings, Users & Security.

Migration 045 adds safe read-only product/stock lookup, admin-reviewed supplier memory, English/Tamil answer preferences, browser voice input and playback, and bounded text conversation history. By default each staff member keeps at most 10 conversations for 30 days and each conversation is trimmed to 30 messages. Supplier-list images are sent to Gemini for extraction but are not stored by the app; an admin reviews the extracted text before saving it.

Product and supplier results are only queried when the question explicitly asks for shop stock, price, products or supplier-list information. Video requests return specific clickable YouTube searches; direct video URLs are not invented when live search is unavailable. Read aloud is a toggle, so the same button stops the current answer.

Run `supabase/sql/048_assistant_business_data.sql` after migration 045, then redeploy the `tech-assistant` Edge Function to add read-only business questions. Administrators automatically have access. Staff require the separate **Allow AI to read customer, supplier and financial data** permission. The assistant can then look up matching customer purchases, documents, customer balances, supplier payables and operational totals. Contact details are not sent to Gemini, the assistant cannot edit records, and saved business conversations are hidden automatically if the permission is later removed.

Run `supabase/sql/051_assistant_product_search.sql` after migration 050, then redeploy the `tech-assistant` Edge Function. Migration 051 improves product ranking for item codes, barcodes, model numbers, capacity and wattage searches, while keeping the lookup read-only. Staff with Tech Assistant permission also receive the floating Assistant launcher on every POS page, including the mobile layout.

The current Edge Function also performs compatibility-aware catalogue planning and filters the visible product cards through the assistant's final specification check. Redeploy `tech-assistant` after updating the function so device-model questions can search likely part specifications and unrelated same-brand products are not shown as matches.

Run `supabase/sql/054_assistant_strict_product_relevance.sql` after migration 053. It prevents one-word catalogue matches from becoming suggestions, requires the requested product class, and makes numeric requirements such as screen size and pin count mandatory. No Edge Function redeploy is needed for the SQL itself, but the compatibility-aware function code above must also be deployed.

## Thermal profile and job labels

Run `supabase/sql/052_party_codes_thermal_labels.sql` in the Supabase SQL Editor, then run `supabase/sql/055_two_letter_party_codes.sql`. Migration 055 converts both customer and supplier profiles to the same compact `AB-A1B2C3` format: the first two letters of the name, no `CUS` or `SUP` prefix, and a short unique part. Profile pages and selected repair jobs can then open the code-only thermal-label designer, choose small label dimensions such as 20 × 10 mm or 30 × 15 mm, swap orientation, preview the result, and print through the operating system printer dialog.

## Register, cheques and minimum profit

Run `supabase/sql/056_whatsapp_register_margin_cheques.sql` after migration 055. It adds the 5% default minimum-profit rule, cheque references/dates for POS, purchases and party payments, the Cheque bank payment type, and per-device daily register opening/closing reconciliation. The completed-sale screen can share its PDF through the device share sheet; on desktop browsers it downloads the PDF and opens WhatsApp so the file can be attached to the chosen chat.

## Unconfirmed sales and job receipts

Run `supabase/sql/057_unconfirmed_sales_job_documents.sql` after migration 056. POS staff can then save a sale for internal review without posting payment, customer balances, accounting, or reports. Migration 063 adds inventory reservation while the sale is waiting for review. The Documents page shows the internal marker, lets staff edit or delete an unconfirmed sale, and lets an administrator load it into POS for final confirmation. Customer printouts, PDFs, and WhatsApp copies deliberately remain ordinary **Sales Invoice** documents with no visible internal-review wording. Repair jobs can also print or download a dedicated landscape job receipt.

Run `supabase/sql/058_staff_document_attribution.sql` after migration 057. Every new document keeps the active PIN-unlocked POS staff member as its creator and the most recent editor separately. COD orders also lock that creator as **Placed by**, providing a reliable basis for future staff commission reports; another staff member editing the order cannot take ownership of it.

Run `supabase/sql/059_assistant_pos_staff_handbook.sql` after migration 058, then redeploy the `tech-assistant` Edge Function. It adds an admin-editable POS Staff Handbook under **Settings → AI Assistant** and seeds the current sales, return/exchange, COD, job, quotation, payment, purchase, cheque, printing, and daily-register procedures. Staff can ask how to perform a workflow without receiving source-code or write access. The assistant uses exact handbook steps and asks a focused clarification when the correct workflow is uncertain.

Run `supabase/sql/060_assistant_exact_pos_workflows.sql` after migration 059, then redeploy `tech-assistant`. It gives clear POS how-to questions a deterministic answer from the approved handbook instead of allowing the AI model to replace the workflow with generic POS advice. The COD guide explicitly starts from **COD Orders → New Order**, reserves stock on save, and creates the final sale only through **Payment Received - Create Sale**.

Run `supabase/sql/061_party_profile_editing.sql` after migration 060. Customer/Supplier profiles then have **Edit Profile** for contact corrections and safe role promotion. An existing supplier can be marked as a customer, or an existing customer as a supplier, while keeping one profile, synchronizing the purchase supplier record, and retaining existing roles and document history.

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

Run `supabase/sql/062_start_fresh_and_aronium_imports.sql` after migration 061. It updates the administrator-only reset under **Settings → Backups & Restore → Start Fresh** for the newer cheque-payment schema. Unlock the POS with an administrator PIN before running the reset.

Run `supabase/sql/063_party_delete_review_reservations.sql` after migration 062. Review sales then reserve tracked stock while awaiting administrator confirmation, release the reservation when deleted, and convert it into the normal stock deduction when confirmed. Administrators can also delete unused customer/supplier profiles, while profiles with balances, documents, supplier purchases, or warranty history remain protected.

Run `supabase/sql/064_quantity_only_stock_adjustments.sql` after migration 063. Stock Adjustment then changes Sellable, Damaged, or Checking quantities without changing a product's average cost or selling price and without creating cashflow. Inventory gains and losses remain valued at the existing average cost for accounting. Reserved units remain protected and must be released through their source COD or review-sale document.

Run `supabase/sql/065_purchase_cashflow_payment_rules.sql` after migration 064. Purchase and Stock in Transit payments then respect the selected payment type's **Affects Cashflow** setting. The migration also removes earlier purchase cashflow rows made through payment types that are currently configured not to affect cashflow; document totals and payment status remain unchanged.

Run `supabase/sql/066_delivery_orders_prepaid.sql` after migration 065. The former COD queue then becomes Delivery Orders with COD and Prepaid modes. COD continues to reserve stock until courier settlement, while Prepaid records payment and creates the linked sales invoice immediately. Both modes share packing, dispatch, tracking, returns, WhatsApp notices, and three address-only labels per A5 sheet.

Run `supabase/sql/067_sales_invoice_corrections.sql` after migration 066. Administrators, and staff explicitly granted **Edit finalized sales documents**, can correct a posted sales invoice from Documents. Saving reverses and reapplies its stock, customer balance, payment, cheque, cashflow and accounting effects while retaining its original invoice number and creator.

Run `supabase/sql/068_sales_invoice_deletion.sql` after migration 067. Administrators, and staff explicitly granted **Delete finalized sales documents**, can delete an eligible sales invoice with automatic reversal of stock, customer balance, payment, cheque, cashflow and accounting effects. Invoices with linked returns, warranties or dependent documents remain protected. Closed daily-register totals are also kept synchronized after later cashflow corrections.

Run `supabase/sql/069_enforce_payment_cashflow_setting.sql` after migration 068. This enforces **Affects Cashflow** at the cashflow table for every workflow, including purchases, sales and document corrections. Payment types with the setting disabled can still mark a document as paid, but cannot add Cash In or Cash Out to the shop register. The migration also removes earlier incorrect cash movements made with currently opted-out payment types without changing document, stock, cost or party-balance records.

Run `supabase/sql/070_all_payment_account_balances.sql` after migration 069. The Cashflow page then shows every payment type, ordered by cash, bank, credit and other and by usage within each group. Credit cards show recorded non-cash activity, while opted-out and inactive methods are clearly marked. Transfers remain limited to active cash/bank methods that affect cashflow. Existing paid payment types can also be reclassified between Cash drawer, Bank account and Other from Settings.

Run `supabase/sql/071_track_non_cashflow_payment_accounts.sql` after migration 070. Paid methods with **Affects Cashflow** disabled then retain payment-account movements and running balances without entering Cash In, Cash Out, Net, transaction-history exports or the daily register. The migration restores recoverable opted-out payments previously removed by SQL 65/69. Purchase save/edit keeps these account movements from then on.

Run `supabase/sql/072_purchase_edit_final_stock_validation.sql` after migration 071. Purchase edits then validate the final stock quantity after the old and revised quantities are compared. A valid edit is no longer rejected merely because reversing the old purchase would be temporarily negative; cost, supplier balance, payments, account movements and stock history still use the existing transactional reverse-and-reapply process. Final stock must remain non-negative and cannot consume reserved units.

Run `supabase/sql/073_random_five_character_job_codes.sql` after migration 072. New repair jobs then receive a unique, non-sequential five-character code such as `7K3MP`. Codes always mix letters and digits and omit easily confused characters; existing job numbers are retained unchanged.

The reset requires the exact phrase `RESET SHOP DATA` and creates a manual safety backup before it clears products, stock, customers, suppliers, documents, cashflow, warranties, online orders, accounting activity and saved assistant conversations. It preserves staff/admin accounts, PINs, trusted devices, permissions, company/application/printing settings, payment methods, online-store settings and assistant supplier knowledge. At least one active administrator must remain.

Uploaded storefront image files are retained in Supabase Storage so the safety backup can restore their product links. Remove orphaned files separately only after the reset has been checked and the safety backup is no longer needed.

## Aronium data import

The Products page accepts Aronium's product CSV directly, including its group hierarchy, SKU, cost, markup, selling price, enabled/service flags and quantity. With **Import stock quantity** enabled, negative opening quantities are changed to zero. The Stock page also accepts Aronium's stock-report workbook through **Import Stock** and matches rows by product code.

The **Customers & Suppliers → Import Profiles** action accepts the Aronium customer export. It ignores the built-in Walk-in customer, imports rows marked as customers, treats rows explicitly marked as non-customer as supplier profiles, and safely matches repeat imports by name and phone.
