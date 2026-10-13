---
title: Import wizard
summary: Four steps to bring records in from a file or another system; nothing is written until the third is approved.
audience: builders
owner: records-ux
status: draft
---

# Import wizard

1. **Upload.** A drop area for a CSV, and source chips (Clio, Lawmatics, HubSpot, Google Contacts) for the other-system path.
2. **Match columns.** One row per column with an example value and a picker of the type's fields; `guessMapping` pre-fills by name (same name first, then a header that holds a field's name; a field is taken once). Skip leaves a column out.
3. **Check.** `importIssues` finds the rows that would be refused (empty required value, repeat in a unique field, not a number, not a date); `importSummary` says "3 of 6 rows are ready". A segmented choice sets what to do with a row that matches an existing record (Skip, Update, Add anyway). The button says exactly how many will be imported.
4. **Done.** Counts added, updated, skipped, left out; an undo stays for 7 days.

The wizard is the screen. The import tool that does the writing is server-side and needs rc1-d. File: `apps/app/ui/records/ImportWizard.tsx`. Status: draft, gallery only.
