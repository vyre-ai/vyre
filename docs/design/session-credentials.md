---
title: "Session credentials: real keys, not narrow tools"
summary: How a Claude Code session gets vault items as its own environment, how it can ask for more mid-session, and how an "acts as me" key stays behind an egress proxy instead of ever reaching the model.
audience: builders, agents
owner: vault
status: draft
---

# Session credentials

Status: draft, for the lead and e2e. Depends on: `docs/design/session-credentials.md` (this file,
now committed - sessions and the assistant team asked for a sha). Related: the assistant's
delegated "give a session a login" power (work/assistant, b339af42), cohesion audit findings 1
and 5, the project column on grants (below, done this session).

## What exists today

- `vault://item/field` refs, resolved by `vault.resolve` and written into a file by `vault.render`
  (never printed).
- `vyre vault run --env-file` and `vault.inject`: items into one child process's environment, on
  disk nowhere, person-only today (`PEOPLE` callers).
- `vault.grant {name, module, watcher?, project?}` / `ctx.vault.fetch`: a *module* holds a standing
  grant, declared in its manifest's `needs.vault` or `needs.credentials`. This is process-wide
  access for code that is always running, not scoped to one session or one ask.
- `vault.need` / `needs_credential`: a module's unmet needs, and the form to fill one
  (`vault.connect`).
- Grants can now name one project (see below); nothing yet asks for a credential *from inside a
  running session* the way this doc describes.

Sessions are a different caller shape: short-lived, one per project (usually), asking for things
interactively rather than declaring them once in a manifest. None of the above fits a session
asking mid-conversation, "let me send this email" - that is the gap this doc closes.

## 1. A catalog a session can see (S)

`vault.catalog {project?}` (new, session callers; `read: true`, no presence): every item's `id`
(stable, already exists as `name`... today an item's `name` doubles as its id and its display
label; this introduces no new id scheme, it is the existing name), `kind`, and whether it is
already usable in this project (granted, needs_credential, or unknown). Filtered to what a session
could plausibly ask for - items whose `kind` is not `passkey` or `ssh-key` (those never leave the
vault; a session cannot ask for them, full stop) and whose vault is `agents` (a locked personal
item is not offered until it is open). Never a value, never a field name that would hint at one
beyond the kind (a `login` has a password; that much is already public).

## 2. `vault.request {item | kind, reason}` (M)

A session calls this (through `ctx.call`, same path as any other tool) naming either a specific
item id or a kind ("something that can send mail"), with a short reason string it composed (shown
to the person, never sent anywhere else). It:

- Refuses at once if the item does not exist or is a passkey/ssh-key.
- If a grant already covers this module *and this project* (see the project column below), fills
  silently - no ask raised, just the audit row (`release`, source `request`). This is the no-nag
  rule: a repeat ask in the same session for the same item merges into the one open row instead of
  raising a second.
- Otherwise raises one row through `core/waiting` (a new kind, `credential`, added to
  `KINDS`), with `answer: {tool: "vault.request.answer", input: {id}}` and `fill: {scope, expiry}`
  - the two things only the person can give. This is the same contract every other waiting row
  uses (cohesion's one list): it shows in the session as an inline ask card, in the assistant, the
  Capsule, the Deck, on the phone as a swipe, and on the vault page, and answering it in any one of
  them clears it everywhere (`waiting.changed`).
- A title that never carries a value: `"<session/agent> wants <item or kind> for <reason>"`,
  through `core/waiting`'s existing `clean()` secret-filter as a second line of defence.

## 3. Approve with a scope (S, once `vault.request` exists)

`vault.request.answer {id, decision: "approve"|"deny", scope?, expires?}`, person-only.
`scope` is one of `once | session | project | agent` (a repeatable pattern already used for
approvals elsewhere in the vault) and becomes a grant: `once` never persists (the value is handed
over and the ask is done); `session` is a grant scoped to a session id (needs sessions to hand
vault a stable id per running session - coordinate the exact shape with sessions, not invented
here); `project` uses the project column; `agent` is today's plain module grant, unscoped. Touch ID
(presence) is asked only when the item is marked `acts as me` (see 4) or the scope is `agent` with
no expiry - the broadest, most standing grants. Everything narrower (once, session, a project, or
anything with an expiry) needs no Touch ID, per the no-nagging rule cohesion's interaction pass
already set for reversible/cheap actions; a bad approval is undone with a revoke, not prevented
with a dialog.

## 4. After approval: env var, or a placeholder through the egress proxy (L)

Two shapes, decided by the item's own `acts as me` flag (new, on `kind: login`/`api-key`/`oauth`
items that can send mail, post, or pay - set at `vault.put`/`vault.connect` time from the
provider's catalog entry, the same catalog `connections.js` already reads capabilities from):

- **A normal key** (read-only APIs, most `db-url`/`cloud`/`pat` items): the real value, as an env
  var, filled at session start for items the project or agent already holds a grant for, and
  filled into the *running* session the moment `vault.request` is approved for anything asked for
  mid-session. Never written to disk; the system prompt is told the variable's name, this item's
  "how to use" line (already exists on some catalog entries as `label`/purpose text) and the
  approval policy in force, and is told plainly never to print the value.
- **An "acts as me" key** (send mail, post, pay): the session gets a placeholder string instead of
  the real value (an opaque token, not a value-shaped string a leak would matter). A Vyre egress
  proxy - a small HTTP forward proxy the server session's outbound calls are routed through -
  recognises the placeholder in an outbound request, swaps in the real key on the way out, and (per
  a connector setting in the settings hub: `always` / `only for sends` / `never`) holds the
  request at the Gate until the person approves it, the same held-draft mechanism the Gate already
  has for messages. The system prompt mirrors the setting in force, so Claude behaves well even
  though the enforcement is the proxy's, not the prompt's - a prompt injection cannot talk the
  model out of a hold the proxy itself enforces.
  - **What is and is not enforceable.** A server session (`vyre-agent`) can be firewalled to force
    all egress through the proxy - no other path out. A session on a person's own Mac cannot be
    firewalled the same way without also touching that person's whole network stack; there, the
    proxy is the *given* path (the placeholder is useless anywhere else) but not the *only
    possible* one if the model's own sandbox is broken out of. Be honest about this in the UI: a
    Mac session's "acts as me" protection is "the real key never reaches the model", not "outbound
    traffic is physically unable to bypass the Gate."

## 5. Scrubbing (S, mostly built)

The PostToolUse hook already exists for other redaction; add every currently-open session's real
values (and, for a placeholder, nothing - it was never real) to its scrub list, so a value that
somehow reached a tool's output is caught before it reaches the transcript. This is a backstop,
not the primary control; 1 and 4 exist so there is usually nothing to scrub.

## The project column on grants (done this session, `d.` below is the sha)

Cohesion audit finding 1 (top-ranked): a grant was per-module only, so a teammate shared across
two projects would carry one client's credentials into the other's the moment teammates ships.
`vault_grants` now has a `project` column (`""` = every project, matching how `watcher` already
uses `""` for "not applicable" - not `NULL`, which SQLite would never deduplicate against itself).
The table was rebuilt (`UNIQUE (item, module, watcher, project)` widens the old
`UNIQUE (item, module, watcher)`) the same way `share.js`'s `vault_held` migration once did.
`vault.grant`/`vault.revoke`/`vault.release` all take an optional `project`; `vault.release`
(behind `ctx.vault.fetch`) filters by it when a caller passes one, but **nothing passes one yet**
- `ctx.vault.fetch` is a module-scoped call (a module instance runs process-wide, not scoped to a
project), so a *teammate's* actual project-scoped enforcement point is not this call at all. It is
whatever new mechanism teammates/sessions use for a dynamically-identified agent's credential
access (closer to `vault.request` above than to `ctx.vault.fetch`) - coordinate that mechanism's
exact shape with sessions and teammates before teammates' migration step 1 starts, so it is built
against a real project id from the start rather than retrofitted. `vault_agent_grants` (one agent
signed in to one site, decision 2 - a different feature from module credential grants) got the
column too, inert for now.

## Sizes

| Item | Size | Notes |
|---|---|---|
| Project column on grants | **done** | schema, `grant`/`revoke`/`release`, CLI `--project` |
| 1. Catalog | S | one read-only tool over existing item rows |
| 2. `vault.request` + waiting row | M | needs `core/waiting`'s `credential` kind (their file) |
| 3. Approve with scope | S | builds directly on existing grant/presence machinery |
| 4a. Env var at approval | S | `ctx.vault.fetch`-adjacent, already mostly plumbing |
| 4b. Placeholder + egress proxy | L | a new server process, Gate integration, firewall story |
| 5. Scrubbing | S | extends an existing hook's list |

## For e2e

- The placeholder scheme is the whole security model for "acts as me" keys: if a placeholder can
  be told apart from a value-shaped string, or the proxy's swap-in point can be reached from
  outside the session's own request path, the real key leaks. Wants a dedicated review once 4 is
  built, not folded into a general pass.
- `vault.request`'s no-nag merge (a repeat ask becomes the same open row) must not let a *second,
  different* reason silently reuse an approval meant for the first.
- The egress proxy's connector setting (`always`/`only for sends`/`never`) must be read fresh per
  request, not cached at session start, so a person tightening it mid-session takes effect at
  once.
- Scope `agent` with no expiry is the only path that still asks Touch ID; confirm every other path
  (once, session, project, or anything with an expiry) truly cannot be reached without it,
  matching cohesion's reversible-vs-secret split.
