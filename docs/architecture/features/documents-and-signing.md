---
title: Documents and signing
summary: Fill a Word template from a record and the records linked to it, file the result on the record, and send it for signature to a signer who needs no account.
audience: builders, agents
owner: docs
status: stable
---

# Documents and signing

## What it is
Documents fills a business's own Word template from a record and the records linked to it. The result is the same file every time, and Vyre files it in the Space's Drive and on a Document record. No model writes or rewrites the text.
Signing sends a template to a signer by email through the Documents app. The signer opens a link and signs with no account. The signed copy files back on the record.

## What a person sees
- The **Documents** screen has tabs **Made**, **Waiting** (owner and admins; **Nothing is waiting** when empty), **Word templates** and **Setup** (owner and admins). The owner or an admin uses **Add a Word template**; everyone else sees the templates. Each template card has **Make document**.
- A record page carries the Documents bar. **Make document** asks for a template and a format, **Word** or **PDF**, then **Make it**. **Send for signature** asks for a signing template, an optional signer name and a note, then **Send**. A banner reading "This template also asks for" lists the placeholders the record cannot supply.
- **Waiting for signature** lists what nobody has signed, with **Remind**.
- If the Documents app is not on the server, the setup tab offers **Install the Documents app** and **Start it**. **End all signed-copy links** stops every link made so far.
- Sending is a held act. The person reads the email and says yes once.

## How it works
**Templates** are `.docx` files at `Templates/<name>.docx` in the Space's Drive. The Drive keeps every version, and a document remembers which version made it. `documents.template.add` stores one (10 MB at most) and answers with its placeholders and loops.

**Filling** (core/documents/fill.js) is plain template substitution. Placeholders look like `{client.name}` and loops like `{#items}{label}{/items}`. Values come from `values` and from `records`, a map of alias to record URN. Each record is read under the caller's own chain, and a placeholder that crosses a link (`{contact.spouse.name}`, or a loop over a many link) reads the linked record the same way (lib/link/path.js). A `brand` object from the Space's brand profile is there unless the caller supplies one.

**Deterministic.** The code gives a model nowhere to write. The module's description says so: a missing value stops the document and names itself. An undefined, null or empty-string value stops the run, and the error `missing_values` lists each one. `0` and `false` count as values. The zip entries carry one fixed date, so the same template and values give the same bytes. The agent-facing rule matches: an agent that sees a missing value fixes the record or passes `values`, then calls again.

**Filing.** `documents.generate` writes `Documents/<project>/<name>-<hash>.docx`, or `.pdf` through a converter that runs beside Vyre or comes from the PDF converter app. With no converter, the PDF is refused in words and the Word file still works. It then creates a Document record when the Space has a type named `document`. The Documents Kit defines one with name, status, template, signer_email, signed_at, file, submission, contact and project, and a field the type lacks is skipped. It emits `documents.generated`.

**Signing.** A person sends from a record: `documents.send` takes `template_id` and `email` or `contact`, asks the Documents app for a request (`appmods.signing.request`) and emails the signer their link through `comms.send`. The signing page is public at the app's own address under `/s/:slug` (core/appmods/catalog/documents.json). Nothing else of the app is public, and the signer needs no account.

When the signer finishes, the app's webhook becomes the event `documents.signed`, or `documents.declined` if they refuse. The signed copy lands in the Drive and on the record. Either event can start a Flow. `documents.signing.flow` returns a ready Flow without creating it: it sends at a stage, waits for `documents.signed` and moves the record on (core/documents/signing.js). The Documents Kit ships a Flow named `document_signed` (core/appmods/catalog/documents.kit.json) that finds the signer's Contact by email, files a Document record linked to them and puts it on their timeline. See [docs/using/documents.md](../../using/documents.md).

`documents.send-signed` emails a signed-copy link. It lasts until revoked unless `days` or the setting `documents.signed_link_days` sets an end. `documents.signing.remind` sends the link again.

**Checks.** Each tool opens the caller's own chain in the Space (lib/gateway-door.js). A call that proved no person is refused, the kernel's Drive and record grants decide what can be read and written, and a Space with no Drive answers `unavailable`. module.json declares `documents.send`, `documents.send-signed`, `documents.signed-link` and `documents.signing.remind` as outward, so the Gate holds an agent's call for the person's yes (see [gate](./gate.md)).

**Events:** `documents.generated`, `documents.sent`, `documents.copy-sent`, `documents.reminded`; from the app, `documents.signed` and `documents.declined`.

## Where the code lives
- `core/documents/index.js` holds the tools, `fill.js` the template engine, `pdf.js` the converter call, `record.js` the Document row and `signing.js` the signing Flow.
- `core/documents/module.json` lists tools, events, Flow steps and settings (`documents.signed_link_days`, `documents.pdf`).
- `core/appmods/catalog/documents.json` and `documents.kit.json` define the signing app, its public routes, the webhook mapping and the Documents Kit.
- `lib/link/path.js` reads through links for placeholders.
- `apps/app/screens/documents/` is the Documents screen, `apps/app/screens/records/DocumentsBar.tsx` the bar on a record page, and `apps/app/ui/setup/fieldtokens.js` the field list's tokens.

## How agents use it
An agent lists templates with `documents.template.list` and `documents.template.get`, makes a file with `documents.generate`, and asks for `documents.send`, `documents.send-signed` and `documents.signing.remind`. The person decides on those three. `documents.signing.waiting` reads what is unsigned. Flows use the same names as steps. An agent never retypes a firm document. When a value is missing, it fixes the record or passes `values`, then calls again. See agent doc "outward-acts" and [docs/using/documents.md](../../using/documents.md).

## Limits and extension points
- In 0.5 a document comes from one Word template filled from records. A business that needs a bundle of documents per matter, another signing provider or a document fed by an outside system adds a custom module.
- [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related
- [records](./records.md), [files](./files.md), [flows](./flows.md), [gate](./gate.md), [apps](./apps.md)
- [map](../map.md), [overview](../overview.md)
- [docs/using/documents.md](../../using/documents.md), [docs/reference/events.md](../../reference/events.md)
