---
title: Mail over IMAP and SMTP
summary: Connect any mailbox that speaks IMAP and SMTP, search and read it from Claude, and send from it with every message held at the Gate for your approval.
audience: users, agents
owner: connectors
status: draft
---

# Mail over IMAP and SMTP

The `mail` module reaches any mailbox that speaks IMAP and SMTP: a hosting provider's mail, a
company server, an app password on a personal account. Google accounts have their own module
(see [Connectors](connectors.md)); this one is for everything else.

It keeps the same promises as the other connectors. The login lives in the [vault](vault.md),
and Vyre never shows it. Reading happens on demand, and nothing polls. Every message you send
waits at the Gate until you approve it.

## Add an account

An account is one vault item of kind `env-set` whose provider is `imap-smtp`. Its name is the
account's name. The CLI asks for each value without echoing it:

```
vyre vault put harlow-mail --kind env-set --provider imap-smtp \
  --field imap_host --field imap_port --field smtp_host --field smtp_port \
  --field username --field password --field from --field security
vyre vault grant harlow-mail mail
```

| Field | What it holds |
| --- | --- |
| `imap_host`, `imap_port` | The IMAP server, such as mail.harlow.example and port 993 |
| `smtp_host`, `smtp_port` | The SMTP server, such as mail.harlow.example and port 465 or 587 |
| `username`, `password` | The login, often your address and an app password |
| `from` | The address mail goes out from. Optional; the username when left out |
| `security` | `tls` (TLS from the first byte, ports 993 and 465) or `starttls` (ports 143 and 587) |
| `tls_ca` | Optional: a PEM certificate to trust, for a server with its own certificate authority |

Vyre never sends a login in the clear: with `starttls`, a server that does not offer STARTTLS is
refused before the login. SMTP logs in with AUTH PLAIN or LOGIN, whichever the server offers.

Then check it. `mail.test` logs in to both servers and out again, and reads and sends nothing:

```
vyre call mail.test '{"account":"harlow-mail"}'
```

## Who may use it

Before every call the module asks the vault whether the calling surface may use this
connection. A new connection is open to the Capsule and chat; agents are opt-in. You grant and
revoke surfaces in Vault, Connections. If the vault cannot answer, the module refuses.

## The tools

| Tool | What it does |
| --- | --- |
| `mail.accounts` | The accounts this surface may use: names and hosts, never a password |
| `mail.test {account}` | Log in and out of IMAP and SMTP. People's surfaces only |
| `mail.search {account, query?, mailbox?, limit?}` | Newest first, 20 by default. `query` takes `from:dana`, `subject:"engagement letter"`, `since:2026-09-01`, `unseen`, and plain words |
| `mail.read {account, id}` | One message as plain text; an html-only message has its tags stripped |
| `mail.send {account, to, cc?, subject, body, reply_to_id?}` | Holds the email at the Gate and returns the held id |

Mailboxes open read-only, so searching and reading never mark a message as read. `reply_to_id`
takes an id from `mail.search` and makes the message a reply in that thread.

## Sending

`mail.send` sends nothing. It checks the message (a line break in a header is refused) and
holds it at the Gate under `mail:<account>`, so you see which address it would leave from. You
approve it, and may edit it first, in the Capsule or the Deck. Only
then does the Gate call `mail.release`, which sends exactly what you approved over SMTP.
