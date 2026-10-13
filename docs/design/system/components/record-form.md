---
title: Record form
summary: The create form of any Records type, drawn from its fields.
audience: builders
owner: app-design
status: draft
---

# Record form

Required fields first, hidden fields left out, the rest in the type's order (`formOrder`). Each field is its kind's own edit renderer (`editField`); a picker (choice, link, actor) draws its own label, which carries ", required". Errors (`formErrors`) show under the field after the first Create, and a Banner counts them. A sealed field is left to its own step. Buttons: Create, Create and add another (resets the form), Cancel.

Implementing file: `apps/app/ui/records/RecordForm.tsx`; pure half `ui/records/logic.js`. Status: draft, gallery only.
