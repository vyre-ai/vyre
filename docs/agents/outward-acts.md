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

## Put a site live

You do every step; the person gives one yes. In this order:

1. `publish.create` with a name, a source and how it builds. Then `publish.preview`. The preview address is private.
2. `publish.secret.grant` only for a Vault item you may use. A real secret is held for the person, so ask for it before step 5, not after.
3. `publish.domain.add` with the host, and `canonical` (`apex` or `www`) when it matters. Read the exact DNS record with `publish.domain.status` (type, name, value), tell the person where to set it, then recheck with `publish.domain.verify` until it says verified. A site that is already live keeps its domains: connecting one is the person's.
4. `publish.plan` to read what goes public, at which address, with which secrets, replacing which version.
5. `publish.go`. It returns `held` with a task and the same plan. Nothing is live.
6. Tell the person: "It is on Now and in this chat. Approve it to put the site live." You cannot approve, and `publish.decide` refuses you. Look at `publish.holds` or `publish.status` to see when it went through. Never call `publish.go` again to nudge it.

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
