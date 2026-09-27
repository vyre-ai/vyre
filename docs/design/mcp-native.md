---
title: "MCP, native: every Claude Code server in Vyre"
summary: What the hub and Connections UI do today for MCP servers, the gap against Claude Code's own config, and the plan to make discovery, multi-account and per-project on/off native (ADR 0016).
audience: builders, agents
owner: connectors
status: draft
---

# MCP, native: every Claude Code server in Vyre

The ask (the lead, 28 Sep 2026): "All of Claude Code's MCP servers should be available there in
the UI, and the multiple thingy should be available natively in Vyre." Two things in one sentence:
every server the person already runs under Claude Code should show up in Vyre without a manual
step, and a server with several accounts (two Gmail MCPs, one per inbox) should read as one thing
with several accounts, not several unrelated rows.

## What exists

**The hub (`core/mcp/hub.js`, ADR 0016 decisions 2-4).** A person adds a server by hand
(`vyre connect add <transport> <name> ...` or the Connections form), which inserts one
`mcp_servers` row: transport, command/args or url, auth (vault item reference, never a value),
scope (which projects and agents may reach it), and a `tools.mode` per tool (read, held, off).
Nothing starts at boot; a server starts on first use, caches its tool list in the row, and stops
after `idle` (default 10 min) with no polling. `mcp.call` classifies each tool as read or outward
by its name (`classify()`) unless the person overrode it, and an outward call holds at the Gate.
Two rows can point at the same command with different vault items: the hub already runs "two
Gmail MCPs, each with its own credential" as two independent rows (`core/mcp/hub.test.js`, "several
instances of one server, each with its own credential").

**Vault connections (`core/vault/connections.js`, ADR 0028 decision 9b, work/vault-next 4d43906e
onward, not yet merged to main). This branch does not have these tools yet; named here as the
contract to build against once it lands.** <!-- terms: ignore -->
`Connections.resyncMcp()` turns every `mcp.servers` row into one `vault_connections`
row: `provider: "mcp"`, `ref` = server name, `account` = the row's label (or name), `capabilities`
guessed from the cached tool names, `auth` from the row's auth type. `vault.connections.list` <!-- terms: ignore -->
answers `{surface, connections: [{id, source, ref, provider, account, auth, label, capabilities,
state, uses, ...}]}`, scoped to a caller's surface; `.grant`/`.revoke` add or remove a surface
(capsule, chat, agents, phone); `.update` renames a connection or sets `default_for` a capability
(one default per capability). So two Gmail rows already resync into two `vault_connections` rows,
each independently grantable per surface: the vault side of "multi-account" is built. What is
missing is grouping, nothing today says "these two rows are the same underlying server."

**Connections UI (`deck/views/connections.js`, part of `deck/views/settings.js`).** Reads
`mcp.servers` and `google.accounts` directly (not vault's connections tools <!-- terms: ignore -->), and renders one row per
server: name, transport, state, tool count, auth kind, scope, per-tool mode. It refreshes on the
open, on an action, and on `mcp.*`/`google.*` events (debounced). No vault-connections plumbing
yet, the Settings section is server-shaped, not account-shaped.

**Discovery today: none.** A server exists in Vyre only if a person ran `vyre connect add` (or the
form did it for them). There is no reading of Claude Code's own `.mcp.json` (project or ancestor
directories), `~/.claude.json`, `~/.claude/settings.json` / `settings.local.json` (project or
user), `$CLAUDE_CONFIG_DIR/settings*.json`, or a plugin's bundled MCP config. The exact file list
already exists, but only as a defence: `core/harness/rules.js` (`ccFile`, `hardLinked`, lines
272-330) walks this same set of paths so the floor can refuse a model editing them or hard-linking
around them. It is read-only-for-protection code in a module connectors does not own; the
discovery feature needs its own reader, in `core/mcp/` or `lib/connectors/`, that parses these
files for `mcpServers` entries (and each `.mcp.json` in `plugins/*/`) and reports servers Vyre does
not yet have a row for. The walk pattern (home file, `.claude/settings*.json` at every directory
from cwd up to `/`, project `.mcp.json`, `$CLAUDE_CONFIG_DIR`) is proven there and should be
factored out, not re-derived.

## The gaps, and their size

1. **Live discovery.** Read Claude Code's config at user, project and local scope, plus plugin
   servers, and diff against `mcp.servers`. Not a one-time import: a person adding a server to
   their project `.mcp.json` after Vyre is running should show up without restarting anything.
   Size: medium. A `core/mcp/discover.js` module: a pure parser (stdio/http/sse shape from
   `mcpServers` entries, the same three transports the hub already knows), a scanner that walks the
   same paths `ccFile` does (factor `ccFile`'s path list into something both can import, or accept
   controlled duplication if `core/harness` cannot be a dependency of `core/mcp`, check with the
   floor before assuming either way), and a light watcher: `fs.watch` on the handful of files (not
   polling; a change event triggers one re-scan, still capped so a flapping file cannot re-scan
   more than once per few seconds). A discovered-but-not-added server becomes a `pending` row (own
   state, distinct from `stopped`/`running`/`failed`) with no vault item and no credential yet.
   Adding it is still an explicit action (the person picks how to authenticate it); discovery only
   removes the "type out the command and args by hand" step.
2. **Multi-account, native.** The vault side already groups by resync (each row is one account,
   already independently grantable per surface). The gap is entirely in the UI and in a stable
   "same server" key: two rows with the same command+args (stdio) or the same url-minus-query
   (http/sse) are the same underlying server; the UI groups them under one card, lists accounts as
   chips, and "add another account" pre-fills the same transport/command with a fresh vault item to
   fill in. Size: small, mostly `deck/views/connections.js` plus reading vault's connections list
   instead of `mcp.servers` directly so grants-per-surface show per account, not per server.
3. **Native per-project/surface on/off, secrets in the vault.** `mcp.servers.scope.projects`
   already exists (which projects may reach a server); what is missing is a one-click UI toggle
   that calls `mcp.update` for scope, and vault's grant/revoke tools for which surface (Capsule,
   chat, agents) may use it, both exist today on work/vault-next. Vault's onboarding step (connect
   a key) is the path for moving a server's secret in: connect the item, then the discovered row's
   `auth` becomes that vault reference instead of an inline env var. Size: small-medium, mostly
   wiring, no new backend contract expected.
4. **UI.** Deck Connections view grouped by server-with-accounts (gap 2), plus a compact list in
   the Capsule ("send from which account?") for a tool with more than one granted account, likely
   near mail's own account picker (`core/mail/`, capsule.js) since that already solves "which
   account sends this" for mail; MCP wants the same shape for a held call. Size: medium, and needs
   app-design's read on the card and the compact list before building (cohesion's
   docs/design/interaction.md: live status events, no polling faster than 60 s, optimistic toggle
   with Undo).
5. **Sessions get the right servers/accounts automatically.** Already true for scope (project,
   agent) through the hub's existing `scope` check on every `mcp.call`; a discovered-and-added
   server is scoped the same way as one added by hand. No new contract needed here, it falls out
   of 1-3.

## Plan

Build in this order: discovery (1) first since nothing else depends on it and it is the part nobody
has started; multi-account grouping (2) next, using vault's connections rows once that branch
lands; then the toggle/vault wiring (3); UI (4) with app-design once 1-3 have a shape to show;
sessions (5) needs no separate work. Tests use synthetic Claude Code config fixtures in temp homes
(`tempHome`, per-test `.claude.json`/`.mcp.json`/`.claude/settings.json` written to the fixture,
never the real `~/.claude`). e2e reviews anything that touches grants or `on_behalf` (discovery
adding a row is module-only; nothing here changes who may call a tool).
