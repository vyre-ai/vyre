# connectors

Branch: work/connectors · Worktree: ../vyre-connectors · ADR: 0016

## Scope

Owns `core/connectors/`, `core/mcp/`, `core/google/`, `core/mail/`, `core/cli/commands/connect.js`,
`deck/views/connections.js`. Small changes by contract in `core/gate/` (a module sender),
`core/harness/rules.js` (the hub's namespace), `harness/mcp/server.js` (aggregation) and
`deck/views/settings.js` (the Connections section).

- The MCP hub (`mcp`): many servers (stdio, streamable HTTP, SSE), credentials from the vault at
  call time, per-project and per-agent scope, lazy start and idle stop, outward tools held at the
  Gate.
- One MCP entry: the harness `vyre` server aggregates hub tools; `vyre mcp` runs it on stdio.
- Native Google (`google`): calendar and mail with OAuth or a DWD service account; sends and
  invites through the Gate; `google.find` for the Capsule.
- Deck Settings, Connections; `vyre connect add|list|remove|test`.

## Done

- The MCP hub: `core/mcp/hub.js` (the Hub class, injected deps), `core/mcp/index.js` (tools and
  callers), `core/mcp/module.json`. Tests: `core/mcp/hub.test.js` (12), `core/mcp/module.test.js`
  (5, real vyred). Idle cost is zero: no timer or child exists until a server is first used.
- One MCP entry: `harness/mcp/server.js` lists `mcp.tools` beside the module tools as
  `<server>__<tool>` (outward ones prefixed "(held for approval) ") and routes those names to
  `mcp.call` with the session key; a held call answers `{ held }` as text plus
  `structuredContent.held`. `capabilities.tools.listChanged` stays false (no notifications sent).
  Test: `test/harness.test.js` (fake stdio server in the hub).
- `vyre mcp` (imports the server, so its ppid is still claude) and `vyre mcp install [--yes]`;
  `vyre connect list|add|remove|test` in `core/cli/commands/connect.js`, with `--var VAR=value`
  added for plain stdio settings (the hub's `vars`). Test: `core/cli/commands/connect.test.js` (3).

- Connect Google, steps 1 and 2 (backend): `core/google/connect.js` with `google.connect`,
  `google.connect.finish`, `google.connect.cancel`; the DWD helper on `google.test`
  (`client_id`, `admin_scopes`); fake Google's authorization_code grant and `consent(url)`.
  Tests: `core/google/connect.test.js` (6), `core/google/module.test.js` (6, real vyred). The
  failure event is `google.connect-failed`: the event bus refuses a name with two dots.
- Read is disabled in Connections for a tool that sends (`mcp.test` marks it `sends`); the
  refusal says "set <tool> to write or off" (lead's decision: no migration, nothing shipped).
- Screenshots: headless Chromium on the test box, shared with pwa, at `CHROME=/usr/local/bin/vyre-chrome`
  (Playwright 1.55.0 build in /opt/ms-playwright, wrapper adds --no-sandbox for Ubuntu 24.04
  AppArmor). `node deck/test/connections-shots.js <out>` renders connections.png and the phone.
- perf-check on the test box 2026-09-27 (branch vs main, same host, load 4 to 8): RSS mean 102 MB branch
  vs 98 MB main, max under 144 MB both; steady-state CPU 0.00% on every sample after the first;
  no recurring timer under 60 s. The only idle timeout is computers' 60 s one. Both branch and main
  sometimes fail "sustained" at about 13% from a single ~64% FIRST sample (the tail of startup
  indexing caught by the idle window); main did it on 1 of 3 runs, the branch on 3 of 4. It is
  a perf-check boundary flake, not a standing cost; reported to the lead.
- `vyre connect add google <name> --sign-in [--client <vault item>]` in
  `core/cli/commands/connect.js`: follows `/v1/events/stream?type=google.*&since=latest` (opened
  before google.connect, so no event is missed), takes a pasted address on stdin for
  google.connect.finish, cancels on Ctrl-C (or end of input only when stdin is a TTY), one 10
  minute timer and no polling. The browser opens only with dialogsAllowed() and a TTY. Tests:
  `core/cli/commands/connect.test.js` (9, six new: loopback, paste, missing client, refused
  flags, cancel on SIGINT, empty non-TTY stdin still finishing through the loopback).

## Doing

- Mail (ADR 0016 decision 8, lead approved 2026-09-27): built on work/connectors. `core/mail/`
  with the google, mcp, apps-script and imap adapters, mail.accounts/map/test/send/search/read,
  Capsule mail.find + mail.compose, mail.release. `account` = vault connection id. Tests: 74 mail
  + message unit and module tests (module test runs on a fake ctx, since vault.connections is on
  work/vault-next), 130/130 neighbours (google, mcp, connectors, gate, harness, connect), docs
  tests green (docs-check: only the 263 pre-existing shot mtimes).
- 4de05249: needs.credentials (imap, apps-script), need ids in needs_credential, google.connect client defaults to google-oauth-client (vault's oauth `next` passes only a name). NOT yet run: core/mail/module.test.js and core/google/module.test.js after this change (testbox held at load 20 by the lead); run them first when it is free.
- Landing plan (lead): after e2e approves hold/on_behalf, push as finished and hand the integrator the sha for the batch after batch 4, together with vault's connections (9b).
- Waiting: vault's module-only `vault.connections.list {caller}` and `use` entries pointing at
  mail.*; then a real-vyred mail test once both are on main.

## Next

1. e2e review of the mcp.call `hold`/`on_behalf` and google.mail.send `on_behalf` inputs (lead's
   condition before merge).
2. After vault lands connections: real-vyred mail tests (IMAP, Apps Script, Google, two MCP
   instances) and drop the fake-ctx gap note.
3. capsule-pro: render mail.find rows ("Send from ...") and open the Gate card after mail.compose.
4. `vyre connect` for mail.map (CLI), and the Deck row in Connections (with pwa/native-core).

## Needs from others

- vault: module-only vault.connections.list {capability?, caller} answering for that caller's surface; useOf send_mail/read_mail of every source -> mail.send/mail.search {account: id}; google-apps-script default capabilities send_mail+read_mail; take core/mail out of work/vault-next (6a0c0760).
- e2e: review hold/on_behalf (lead's condition).
- capsule-pro: Capsule rendering of mail rows.

- Lead: whoever owns scripts/perf-check, on the first-sample flake.

## Changed contracts

- `mcp.call` takes `hold: true` and `on_behalf {thread, agent}`, heard from module callers only (core/mcp/index.js, hub.js).
- `google.mail.send` takes `on_behalf {thread, agent}`, heard from module callers only.
- core/google/mail.js helpers moved to core/connectors/message.js (re-exported; same behaviour).
- New module `mail` with tools mail.*; Gate senders `mail:<connection id>`; event mail.needs-credential.

- `gate.request` accepts `agent` in its input from a module caller only (core/gate/index.js), so
  the MCP hub can file a held call under the agent vyred verified for it.
- `harness/mcp/server.js` refuses every request when `VYRE_HUB_CHILD` is set (3 lines).
- `core/harness/rules.js` rule 1 and `gate.route` step aside for `GATED`, an explicit list of Vyre
  module tools that hold at the Gate themselves: today only `google_mail_send` (under
  `mcp__vyre__` and `mcp__plugin_vyre_vyre__`).

## Changed by capsule-apps (2026-09-27, the lead asked)
- Hub errors from a tool call carry `detail.reached`: "no" before the request is handed to the
  client or after the server's own refusal (NOT_REACHED: rpc, spawn_failed, unauthorized,
  session_expired), else "maybe" (exited or closed mid-call, timeout, network). The registry passes
  detail through; the Gate returns it on a failed approval. Tested in core/mcp/hub.test.js.
- TO_KEYS gains conversation_id (557421d).
