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

1. Run `supabase/sql/044_tech_assistant_permission.sql` in the Supabase SQL Editor.
2. Create a Gemini API key in Google AI Studio.
3. Store it as an Edge Function secret: `npx supabase secrets set GEMINI_API_KEY=YOUR_KEY`.
4. Optional model override: `npx supabase secrets set GEMINI_MODEL=gemini-3.5-flash`.
5. Deploy: `npx supabase functions deploy tech-assistant`.

Existing staff receive the assistant permission when migration 044 is applied. Administrators can enable or disable it later from Settings, Users & Security.
