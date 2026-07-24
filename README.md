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
