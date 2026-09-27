---
title: Known gaps
summary: Places where the code does not yet do what the spec, an ADR or a screen says, what the docs describe instead, and which team owns the fix.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Known gaps

These docs describe what the code does today. Where that differs from the spec, an ADR or what a
screen shows, the page carries a **Known gap** note that links here. Each gap below says what is
true now, what to do instead, and which team owns the fix. A gap leaves this page in the same
change that closes it.

## Approving a Mac in the Deck

The Deck approves a pairing: Now, and the **Your devices** step of onboarding, show each Mac that
asks, with a field for the code on the Mac's screen, **Approve** (with your passkey) and **Deny**.
The box refuses an approval that comes from the Mac that is asking (`link.pair.approve`: "a Mac
cannot approve its own pairing"), and on a box only a passkey from the Deck proves presence, so
`vyre link approve` on the box cannot do it either. A Mac's own browser is on the tailnet as that
Mac, so the Deck open on the Mac being paired cannot approve it, although the onboarding step
says to type the code there.

What to do: open the Deck on your phone (or another computer on your tailnet), type the code on
the pairing card on Now, and approve with your passkey. A passkey you made on the Mac works on an
iPhone when iCloud Keychain is on. With only the Mac, a pairing cannot be approved yet.

Owner: deck with link (a decision for the lead). Pages: [install](get-started/install.md),
[onboarding](get-started/onboarding.md), [troubleshooting](get-started/troubleshooting.md),
[the box and the Mac](concepts/box-and-mac.md), [Tailscale](using/tailscale.md).
