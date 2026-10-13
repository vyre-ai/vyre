---
title: Record page parts
summary: The header, the related sections and the one timeline that make up a record page.
audience: builders
owner: app-design
status: draft
---

# Record page parts

- **RecordHeader**: face, title, type, up to three facts as chips (Stage, Owner, Next step: from the type's own list), and the actions a person takes most (Email, Call, New project, Add a note). One primary.
- **RelatedSection**: one per type that links here. Section label with a count, rows that open, "Add an asset" beneath. A type with none says "No beneficiaries yet." and keeps the Add.
- **ActivityFeed**: one timeline for notes, emails, calls and field changes, newest first (`timelineOf`), a chip row to narrow it (All, Notes, Emails, Calls, Changes) and a note box on top.

On a desk the feed takes two thirds and the related sections one third; on a phone they stack, header first. Files: `apps/app/ui/records/RecordHeader.tsx`, `RelatedSection.tsx`, `ActivityFeed.tsx`. Status: draft, gallery only.
