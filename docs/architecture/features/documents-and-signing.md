---
title: Documents and signing
summary: Fill a Word template from a record and the records linked to it, file the result on the record, and send it for signature to a signer who needs no account.
audience: builders, agents
owner: docs
status: stable
---

# Documents and signing

## What it is
Documents turns a Word template with `{placeholders}` and a record's fields into a filled file, the same bytes every time, and files it in the Space's Drive and on a Document record.
Signing sends a template to a signer by email through the Documents app. The signer opens a link and signs with no account; the signed copy comes back to the Drive.

## What a person sees
- **Documents** screen (page title **Documents**) with tabs **Made**, **Waiting** (owner and admins; **Nothing is waiting** when empty), **Word templates** and **Setup** (owner and admins). The owner or an admin uses **Add a Word template**; everyone else sees the templates. Each template card has **Make document**.
- On a record page, the Documents bar: **Make document** (pick a template, choose **Word** or **PDF**, **Make it**) and **Send for signature** (pick a signing template, optional signer name and note, **Send**). A banner says "This template also asks for" a list when the record cannot supply every placeholder.
- **Waiting for signature** lists what nobody has signed, with **Remind**.
- If the Documents app is not on the server the setup tab offers **Install the Documents app** and **Start it**. **End all signed-copy links** stops every link made so far.
- Sending is a held act: the person reads the email and says yes once.

## How it works
**Templates** are `.docx` files at `Templates/<name>.docx` in the Space's Drive; the Drive keeps every version and a document remembers which version made it. `documents.template.add` stores one (at most 10 MB) and answers its placeholders and loops.

**Filling** (core/documents/fill.js). Placeholders are `{client.name}`, loops are `{#items}{label}{/items}`. Values come from `values` and from `records`, a map of alias to record URN: each record is read under the caller's own chain, and a placeholder that goes through a link (`{contact.spouse.name}`, or a loop over a many link) reads the linked record the same way (lib/link/path.js). A `brand` object from the Space's brand profile is there unless the caller gives one. A value that is undefined, null or an empty string stops the document and the error `missing_values` names each one. `0` and `false` count as values. The zip entries carry one fixed date, so the same inputs give the same file.

**Filing.** `documents.generate` writes `Documents/<project>/<name>-<hash>.docx` (or `.pdf`, through a PDF converter that runs beside Vyre or comes from the PDF converter app; with none, the PDF is refused in words and the Word file still works). It then creates a Document record when the Space has a type named `document` (the Documents Kit defines one with name, status, template, signer_email, signed_at, file, submission, contact, project). A field the type lacks is skipped. It emits `documents.generated`.

**Signing.** `documents.send` takes `template_id` and `email` or `contact`, asks the Documents app for a request (`appmods.signing.request`) and emails the signer their link through `comms.send`. The signing page is public at the app's own address under `/s/:slug` (core/appmods/catalog/documents.json); nothing else of the app is public. When the signer finishes, the app's webhook becomes the event `documents.signed` (also `documents.declined`). `documents.send-signed` emails a signed-copy link; it lasts until revoked unless `days` or the setting `documents.signed_link_days` is set. `documents.signing.remind` re-sends the link. `documents.signing.flow` returns, without creating it, a Flow that sends at a stage, waits for `documents.signed` and moves the record on (core/documents/signing.js).

**Checks.** Each tool opens the caller's own chain in the Space (lib/gateway-door.js); a call that proved no person is refused, the kernel's Drive and record grants decide what can be read and written, and a Space with no Drive answers `unavailable`. `documents.send`, `documents.send-signed`, `documents.signed-link` and `documents.signing.remind` are declared outward in module.json, so an agent's call is held for the person's yes (see gate).

**Events:** `documents.generated`, `documents.sent`, `documents.copy-sent`, `documents.reminded`; from the app: `documents.signed`, `documents.declined`.

## Where the code lives
- `core/documents/index.js` the tools; `fill.js` template engine; `pdf.js` converter call; `record.js` Document row; `signing.js` the signing Flow.
- `core/documents/module.json` tools, events, Flow steps, settings (`documents.signed_link_days`, `documents.pdf`).
- `core/appmods/catalog/documents.json` and `documents.kit.json` the signing app, its public routes, webhook mapping and the Documents Kit.
- `lib/link/path.js` reads through links for placeholders.
- `apps/app/screens/documents/` the Documents screen; `apps/app/screens/records/DocumentsBar.tsx` the bar on a record page; `apps/app/ui/setup/fieldtokens.js` the field list's tokens.

## How agents use it
An agent lists templates with `documents.template.list` and `documents.template.get`, makes a file with `documents.generate`, and can ask for `documents.send`, `documents.send-signed` and `documents.signing.remind`; those are held for the person. `documents.signing.waiting` reads what is unsigned. Flows use the same names as steps. An agent never retypes a firm document: if a value is missing, fix the record or pass `values`, then call again. See agent doc "outward-acts" and [docs/using/documents.md](../../using/documents.md).

## Limits today
- None recorded in docs/known-gaps.md for Documents.

## Related
- [records](./records.md), [files](./files.md), [flows](./flows.md), [gate](./gate.md), [apps](./apps.md)
- [map](../map.md), [overview](../overview.md)
- [docs/using/documents.md](../../using/documents.md), [docs/reference/events.md](../../reference/events.md)
