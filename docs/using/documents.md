---
title: Documents and Comms
summary: Make a document from a Word template and your records, file it on the client, send it for signature from a stage, and deliver the link by email or text, with every send held for your yes.
audience: users, builders
owner: connectors
status: draft
---

# Documents and Comms

Flows orchestrate. Documents makes and files. Comms delivers. One job each.

## Make a document

A template is a Word file in your Drive under `Templates/`, with `{placeholders}` where the record's words go: `{client.name}`, `{matter.fee}`. Add one with `documents.template.add` (a Word file up to 10 MB; it answers the placeholders and loops it found); the Drive keeps every version and a document remembers which version made it.

`documents.generate` fills a template from values and from records you name by reference (`records: { client: <record> }`, so `{client.name}` fills from the record's field). It answers the path, version, size, hash and format. The same input makes the same file. If a value is missing, blank, or a list has nothing to repeat, nothing is made and the error names every one of them; Vyre never guesses.

The result is filed in the Drive under `Documents/<project>/` and, when your Space has the Document record type, as a Document record linked to the client and the project. Ask for `format: "pdf"` to get a PDF. On a server with Records the converter (Gotenberg) runs beside Vyre by default; on any other server, install "PDF converter" from Apps (the same converter, pinned, with no way out of your server), and Documents finds it by itself. With neither, a PDF says plainly what it needs, and the Word file is still made.

## Send for signature

`documents.send` sends a template for signature: it makes the signing request and emails the signer their link through Comms. That is one act with one yes: you read the words once, and the signing app sends nothing of its own. When the signer has signed, `documents.send-signed` makes a link to the finished copy and emails it to the signer, again one yes. The link does not expire: a client can open their signed contract from that email years later. The setting `documents.signed_link_days` (Settings, Documents) gives new links an end after that many days; 0 turns it off. A new link is one call away: `documents.signed-link` with the signer's `slug` (and `days`, 1 to 3650, to end it sooner). The finished file is behind a separate key held by your server, not behind the signer's own address, so the signing page alone never opens it. `documents.signed-link.revoke` ends every link made so far, and the next link made works again.

In the Documents screen, Send for signature shows the signer, the template and your note; confirm it and the signer gets their link by e-mail. From an agent, the approval card for `documents.send` carries the whole act. From a Flow, your answer to the Flow's own question is the yes: nothing waits at the Gate afterwards. Either way, what you read before saying yes is the signer, the template and any note; the link line is fixed.

If the signer declines instead, Documents says so at once: the Document is filed as Declined on the signer's Contact (their timeline shows it), and the event `documents.declined` carries the reason they gave for a Flow of your own to use.

## Waiting for a signature

A document you sent that nobody has signed shows in Needs you as a quiet row: "Dana Juniper has not signed Engagement letter", with the address it went to. Nothing pushes for it. It goes away when the signature arrives, the signer declines, or the request lapses. Its answer is `documents.signing.remind`, which emails the signer their link again (the same one yes as any send; add a short note if you like). `documents.signing.waiting` returns the same list to an assistant. The signer's link and code are never on the row.

## Sign from a stage

`documents.signing.flow` returns a ready Flow: when a record enters the stage you name, it sends the document for signature (your yes), remembers it on the record, waits for the signature, moves the record to the stage you name, and emails the signer their signed copy (your yes). It sends once per record. Define it with the Flows tools like any other Flow.

The signer is either on the record (`email_field`, and `name_field` for the name) or is the Contact the record links to (`contact_field`, such as a project's `client`). With a Contact, Documents reads the address and the name from the Contact itself, so a Kit's own types (a client, a project) work as they are: the Flow needs no e-mail field and no field to remember the request in, and the stage's one run per entry is what sends it once. A Contact with no e-mail address is said plainly and nothing is sent. `documents.send` and `documents.send-signed` take `contact` in place of `email` the same way.
The signed copy goes out with the same yes as the request: the card for the request says "and then email the signer their signed copy with this same yes", so you answer once, even if the signature comes days later. If the type has a rule that asks for the signature (the Estate matter's `engagement_signed` has to be yes before Drafting), name that yes/no field as `signed_field` and the Flow sets it just before it moves the record.


## Signing pages

A signer outside your network needs a way in. Set the public address of an edge in Settings (Devices, Public address for signing pages and shared links) and their browser reaches your server through it; the edge sees only encrypted traffic and cannot read the page or the signed contract. With none set, only your own devices open these pages.

When you send a document for signature, the signer opens a link on the Documents app's own address (`documents.<your name>.vyre.run/sign/<document>/<signer>`), with no account and no one-time code. The link stays valid until the document is signed. The page wears your logo and colours from Brand, and carries a small credit to its open-source engine in the footer. Nothing else in Documents is reachable from outside: the signer sees their own page and nothing of yours. The finished, signed PDF is not behind that link: `documents.signed-link` makes a separate link to it (the signing flow emails it to the signer for your yes) that does not expire unless you set `documents.signed_link_days`, and `documents.signed-link.revoke` ends them all.

### Your own address for signing pages

To send signers to `sign.yourfirm.com` instead of the Space's address, ask for it: `appmods.domain.add { host: "sign.yourfirm.com" }` (the owner or an admin; Documents must be running and the public address above set). Vyre answers the two records to add at your domain's DNS:

- `sign.yourfirm.com` as a CNAME to `<your name>.vyre.run`, so visitors come to your server;
- `_acme-challenge.sign.yourfirm.com` as a CNAME to the address Vyre shows, which lets your server get the certificate for the domain (only the owner of the domain can add it).

`appmods.domain.list` says where each domain stands: waiting for a record, getting its certificate, or live. Vyre looks again every few minutes. Once it is live, new signing links and links to signed copies use your address; until then they keep the Space's, so nothing breaks while you wait. `appmods.domain.remove` takes it back. Up to five domains.

## Send an email or a text

`comms.send` sends an email through your own mail account or a text through your own Twilio account. It is held at the Gate until you say yes to the final words; a text to several numbers is one yes. Texts need `comms.sms` in `config.json` (`{ "account": "AC…", "from": "+1…" }`) and your Twilio auth token in the Vault: Vault, Connections, Twilio for Comms (an API key's secret works too: put its id, `SK…`, in the id field). Once sent, the message is logged on the client it went to.

## Open source

Signatures run on DocuSeal (AGPL-3.0) and templates fill with docxtemplater (MIT); both are credited in Settings, About, Open-source credits.
