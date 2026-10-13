---
title: Secret field
summary: A key and its value where the value is never drawn until the person clicks Reveal; it shows for 60 seconds, Copy empties the clipboard after 30.
audience: builders
owner: app-design
status: draft
---

# Secret field

One row for a secret: the name's value as a mask, with Reveal and Copy at the end. It is the one way the Vault, sending services, firm keys and MCP keys show a value, so
they all behave the same. For now a reveal is a click (no Touch ID), and an assistant is never given the value.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/SecretField.tsx`, exported from `@vyre/ui` | built |
| Deck, Lumen | not used | |

## Anatomy

A 12-dot mask in mono, then Reveal and Copy as ghost buttons. Under it one 12/16 line in `--label`.

## States

- **Hidden.** The mask. The line says "Hidden until you reveal it. Every reveal is logged."
- **Shown.** The value in mono, selectable; Reveal becomes Hide. The line counts down: "Shown for N seconds, then hidden again." It hides itself at 60 seconds.
- **Copied.** The value goes to the clipboard; the line says it is emptied in 30 seconds, and it is.
- **Failed.** The line says why (the value could not be read).

## Behaviour

`read` is called only at the click, so a screen holds no value before then. Every reveal and copy is reported to `onAudit`, which the screen sends to the Vault's log.
