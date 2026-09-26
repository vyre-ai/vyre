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

## Rules do not run on calls through vyred

Spec Section 5.3 says every tool call passes through the Rules. The module registry has the hook
for it, but vyred does not wire one in. The Rules run in Claude Code's `PreToolUse` hook, so they
cover what a Claude Code session does, not a call a module or a surface makes to vyred directly.
Those calls are still checked for input shape, allowed callers and presence.

Owner: integrator. Pages: [the module contract](build/module-contract.md),
[the security floor](concepts/floor.md).

## ctx.projects does not exist

Spec Section 5.2 lists `ctx.projects` among the members a module gets. It is not there. Call
`ctx.call("projects.list", {})` and the other `projects.*` tools instead.

Owner: integrator. Page: [the module contract](build/module-contract.md).

## Approving a Mac in the Deck

`vyre up` on the Mac and `vyre link approve` on the box both tell you to approve a new Mac in the
Deck, with your passkey. We found no Deck screen that approves a pairing yet. Until one ships,
pairing a Mac to a box that already has a passkey may stall at that step.

Owner: e2e with integrator. Pages: [onboarding](get-started/onboarding.md),
[Tailscale](using/tailscale.md), [troubleshooting](get-started/troubleshooting.md).

## vyre box update does not upgrade the Mac

ADR 0008 says `vyre box update` also updates the Mac's own vyred when the box is newer. It
upgrades the box, then prints a command to upgrade the Mac, which you run yourself. That command
is `npm i -g vyre@latest && vyre up`, and it fails: Vyre is not on npm yet. Run
`npm install -g https://vyre.run/box/vyre.tgz && vyre up` instead.

Owner: integrator. Pages: [looking after your box](using/box-care.md), [the CLI](using/cli.md),
[onboarding](get-started/onboarding.md), [troubleshooting](get-started/troubleshooting.md).

## The Deck's setup commands name a flag the CLI lacks

Settings, Setup in the Deck shows a command beside each onboarding step, such as
`vyre up --step tailscale`. The CLI has no `--step` flag. Finish a skipped step in the Deck, or
run `vyre up` again.

Owner: polish-surfaces with polish-cli. Page: [the Deck](using/deck.md).

## The Deck's pause switch does not resume a watcher

On an agent's board, turning a paused watcher's switch back on sends `watchers.pause` with an
extra `off` field the tool does not know, so the watcher stays paused. Resume it with
`vyre watchers resume <name>`.

Owner: polish-surfaces. Page: [watchers](using/watchers.md).

## The vault says reveal is off by default

The description of `vault.caps` (and so the [tools reference](reference/tools.md)) says reveal is
off by default. vyred returns `reveal: true`: the Deck can reveal a field, behind presence.

Owner: core/vault (the lead routes it). Page: [the Vault](using/vault.md).

## The vault CLI never proves presence

Most `vyre vault` verbs call a tool that needs a person to prove presence: `put`, `import`,
`grant`, `approve`, `share`, `offboard`, `get --copy`, `get --reveal`, `totp`, `read`, `run`,
`inject`, `unlock`, `account unlock`, `delete`, `kit` and `backup`. The command calls vyred
without a proof and never asks for one, so vyred answers `presence_required` and the command exits
with code 3. Use the Deck, or run the tool through `vyre call`, which asks for Touch ID on the Mac.
Never put a value or a password in a `vyre call` line.

Owner: polish-cli. Page: [the Vault](using/vault.md).

## vyre memory correct, merge and split never prove presence

These three tools need presence, and the CLI calls them without a proof, so they stop with
`presence_required`. Correct memory in the Deck, or run the tool through `vyre call`.

Owner: polish-cli. Page: [memory](using/memory.md).
