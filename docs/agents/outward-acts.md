---
title: Sending, paying, posting, deleting
summary: What counts as an outward act, how to ask for one, and what a person sees before it happens.
audience: agents
owner: docs
status: stable
tokens: 650
when: You want to send an email or message, pay, post, publish, share, or delete something, or a call came back held.
---

# Sending, paying, posting, deleting

An outward act leaves the Space or cannot be taken back. You never do one alone. You ask, a person approves, and the system does it.

<!-- agent:outward:start -->

Outward acts are: `send`, `pay`, `publish`, `delete`, `share` (the kernel's outward risks). A tool or a connection operation carries the mark; the mark, not your wish, decides.

A connection's operation is outward when its kind is `change`, `send`, `spend`, `delete`. Reading and drafting are not.

<!-- agent:outward:end -->

## How to ask

1. Draft the exact words, recipient, amount or target. The person will read exactly this.
2. Call the tool that does the act (`gate.request` for a message, a payment or a deletion; a connector's operation; a publish). If the act is outward, the call is held: you get a held result, not a success. One exception: if the person's own words already asked for exactly this (same kind, same recipients), it goes at once and is logged.
3. Tell the person what is waiting and where (Now, or the waiting list). Do not call the tool again.
4. When the person approves, the system sends exactly the approved words. You are told the outcome. A person may edit the words first; trust the settled result, not your draft.

## What the system guarantees

- The credential that sends it (a mail account, an API key) is fetched at the moment of sending. You never hold it.
- What is sent is exactly what was approved, nothing added.
- Two screens approving at once send once. A failed send returns to held.
- You cannot approve, revise or reject. Those calls refuse an agent.

## What to write in a draft

- Use the person's own words and facts you read from records. Say what you do not know.
- Never put a secret in the text. If a value is sealed, write its placeholder (read `sealed-and-secrets.md`).
- One act per request. A batch of ten sends is ten held items so the person can say yes to some.

## When it is refused

A refusal names a reason code. `errors.md` says what each means. The common ones: `needs_presence` (a person must prove they are there), `not_allowed` (your chain may not do this), `draft_only` (this connection only drafts).
