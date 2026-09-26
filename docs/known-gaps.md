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

## vyre box update does not upgrade the Mac

`vyre box update` upgrades the box, then, when the box is newer than the Mac, prints the command
that upgrades the Mac, as ADR 0008 now says. That command is `npm i -g vyre@latest && vyre up`,
and it fails: Vyre is not on npm yet. Run
`npm install -g https://vyre.run/box/vyre.tgz && vyre up` instead.

Owner: integrator. Pages: [looking after your box](using/box-care.md), [the CLI](using/cli.md),
[troubleshooting](get-started/troubleshooting.md).

## The vault CLI never proves presence

Most `vyre vault` verbs call a tool that needs a person to prove presence: `put`, `import`,
`grant`, `approve`, `share`, `offboard`, `get --copy`, `get --reveal`, `totp`, `read`, `run`,
`inject`, `unlock`, `account unlock`, `delete`, `kit` and `backup`. The command calls vyred
without a proof and never asks for one, so vyred answers `presence_required` and the command exits
with code 3. Use the Deck, or run the tool through `vyre call`, which asks for Touch ID on the Mac.
Never put a value or a password in a `vyre call` line.

Owner: polish-cli. Pages: [the Vault](using/vault.md), [your first day](get-started/first-day.md),
[troubleshooting](get-started/troubleshooting.md).

## vyre memory correct, merge and split never prove presence

These three tools need presence, and the CLI calls them without a proof, so they stop with
`presence_required`. Correct memory in the Deck, or run the tool through `vyre call`.

Owner: polish-cli. Page: [memory](using/memory.md).
