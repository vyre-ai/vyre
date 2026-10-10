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

A template is a Word file in your Drive under `Templates/`, with `{placeholders}` where the record's words go: `{client.name}`, `{matter.fee}`. Add one with `documents.template.add`; the Drive keeps every version and a document remembers which version made it.

`documents.generate` fills a template from values and from records you name by reference. The same input makes the same file. If a value is missing, blank, or a list has nothing to repeat, nothing is made and the error names every one of them; Vyre never guesses.

The result is filed in the Drive under `Documents/<project>/` and, when your Space has the Document record type, as a Document record linked to the client and the project. Ask for `format: "pdf"` to get a PDF. On a server with Records the converter (Gotenberg) runs beside Vyre by default; elsewhere a PDF says plainly that it needs the Records server, and the Word file is still made.

## Send for signature

`documents.send` sends a template for signature: it makes the signing request and emails the signer their link through Comms. That is one act with one yes: you read the words once, and the signing app sends nothing of its own. When the signer has signed, `documents.send-signed` makes a link to the finished copy that stops working after 30 days and emails it to the signer, again one yes. A new link is one call away.

From an agent, the approval card for `documents.send` carries the whole act. From a Flow, your answer to the Flow's own question is the yes: nothing waits at the Gate afterwards. Either way, what you read before saying yes is the signer, the template and any note; the link line is fixed.

## Sign from a stage

`documents.signing.flow` returns a ready Flow: when a record enters the stage you name, it sends the document for signature (your yes), remembers it on the record, waits for the signature, moves the record to the stage you name, and emails the signer their signed copy (your yes). It sends once per record. Define it with the Flows tools like any other Flow.

## Signing pages

A signer outside your network needs a way in. Set the public address of an edge in Settings (Devices, Public address for signing pages and shared links) and their browser reaches your server through it; the edge sees only encrypted traffic and cannot read the page or the signed contract. With none set, only your own devices open these pages.

When you send a document for signature, the signer opens a link on the Documents app's own address (`documents.<your name>.vyre.run/sign/<document>/<signer>`), with no account and no one-time code. The link stays valid until the document is signed. The page wears your logo and colours from Brand, and carries a small credit to its open-source engine in the footer. Nothing else in Documents is reachable from outside: the signer sees their own page and nothing of yours. The finished, signed PDF is not behind that link: `documents.signed-link` makes a separate link to it that stops working after 30 days (the signing flow emails it to the signer for your yes), and a new one is one call away.

## Send an email or a text

`comms.send` sends an email through your own mail account or a text through your own Twilio account. It is held at the Gate until you say yes to the final words; a text to several numbers is one yes. Texts need `comms.sms` in `config.json` (`{ "account": "AC…", "from": "+1…" }`) and your Twilio key in the Vault. Once sent, the message is logged on the client it went to.

## Open source

Signatures run on DocuSeal (AGPL-3.0) and templates fill with docxtemplater (MIT); both are credited in Settings, About, Open-source credits.
