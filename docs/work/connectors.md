# connectors

Branch: work/connectors · Worktree: ../vyre-connectors · ADR: 0016

## Scope

Owns `core/connectors/`, `core/mcp/`, `core/google/`, `core/cli/commands/connect.js`,
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

## Doing

Connect Google as smoothly as the rest (lead, 2026-09-27). Plan:
1. (done) Backend (`core/google/connect.js` + tools in index.js): `google.connect {name, client}`
   (people only) starts an installed-app OAuth flow with PKCE S256 and a state, on a one-shot
   loopback listener at 127.0.0.1:0 that lives only while a flow is open (10 min cap), and
   returns `{ id, url }`. `google.connect.finish {id, url}` takes the address the browser landed
   on, for a Deck on another device. Finishing exchanges the code, reads the address from the
   id_token, puts a new env-set item `google-<name>` (client_id, client_secret, refresh_token,
   token_uri) as module:google with grants [google], adds the account, emits
   `google.connected {id, name, email}` (never a value). Fake Google grows an authorization_code
   grant.
2. (done) DWD helper: `google.test` on a service account returns its `client_id` (a public number) and
   the exact scope line for the admin console.
3. (done) Deck: Google form becomes "Sign in with Google" (pick or name the OAuth client item, grant it
   with presence, open the consent page, wait for `google.connected`, paste box as a fallback),
   "Service account" (with the admin-console helper and copy buttons), and "Refresh token item".
4. CLI `vyre connect add google --sign-in` prints the URL and waits (later, if time).

## Next

- Docs pages via the docs team (asked them which pages carry the connectors owner line).
- The real-account run only after the user connects one himself.

## Needs from others

- Lead: whoever owns scripts/perf-check, on the first-sample flake.

## Changed contracts

- `gate.request` accepts `agent` in its input from a module caller only (core/gate/index.js), so
  the MCP hub can file a held call under the agent vyred verified for it.
- `harness/mcp/server.js` refuses every request when `VYRE_HUB_CHILD` is set (3 lines).
- `core/harness/rules.js` rule 1 and `gate.route` step aside for `GATED`, an explicit list of Vyre
  module tools that hold at the Gate themselves: today only `google_mail_send` (under
  `mcp__vyre__` and `mcp__plugin_vyre_vyre__`).
