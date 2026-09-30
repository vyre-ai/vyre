# connectors

Branch: work/connectors-0.2 (off work/vault-next; the old work/connectors is 0.1 history) · Worktree: ../vyre-connectors-02 · ADR: 0016

## 0.2 status, round 2 (30 Sep, the user's must-haves)

Built in the user's order: Railway (proved plain DCR), GitHub wired into the catalog (`via: github`, accounts from the github module), GoHighLevel, Slack (own internal app from a prefilled manifest link; https redirect pasted back; `slack-web` token fallback), Zoom (hosted MCP exists, guided own General app), Google (Workspace BYO presets kept with DWD untouched; personal Gmail decided: OAuth Desktop client published In production, through vault.request), Microsoft (Entra guide, public client, Graph through the vault). All against fakes. What no fake can settle, and needs one real run by the person: Slack's https-loopback redirect and MCP manifest switch, Zoom's loopback in a development-mode app, Microsoft with a bare personal account. Also `#` connector kind (search, resolve, `mcp.grant`) and `connect: ` rows.
Contract note for platform: `CALL_AS.connectors` (vault.put for an api-credential only) conflicts textually with work/platform-contract's `CALL_AS` shape (functions); resolve on rebase. The `mentions` manifest entry is already in `core/connectors/module.json`; it is inert on this base.
New shared-code hunks for vault to review: `core/vault/request.js` (oauthToken, forget, `vault.credential.tokens`), `core/vault/vault.js` (`setApiSecret`), `core/vault/api-oauth.test.js`.

## 0.2 status (updated 2026-09-30)

Owner of the catalog and the connect flows; vault keeps the vault, the Gate, the `#` provider for vault items and the asked-send handshake. Facts: `team/0.2/connectors-catalog.md` (45 vendors probed; 35 of 41 anonymous loopback registrations accepted).

Done, all against fakes (no live vendor, no user account):
- `lib/connector-presets`: 45 presets as data plus 7 vendors ruled out with the reason. `catalogFrom(config)`.
- `core/connectors` is a module: `connectors.catalog|list|connect|connect.finish|connect.cancel|disconnect|persist`. One flow: DCR, own OAuth app, or token. Credential = vault item `<name>-auth`, hosts = the vendor origin, granted to `mcp` and `connectors`.
- `core/connectors/auth.js`: public clients, stored access token used first, rotated refresh token saved via `connectors.persist` (failed save is loud, kept in memory).
- `core/connectors/oauth.js`: optional scopes, `offline`, fixed loopback `port`.
- `core/mcp`: preset host binding (longest id wins), hub passes the row url to `creds.headers` (P21 enforced now).
- CLI: `vyre connect apps`, `vyre connect add app <preset>`, remove/test for apps. Docs: using/connectors.md section.
- Tests: connect.test.js (10), module.test.js (4, real vyred), connect-app.test.js (3, real `vyre` binary), presets index.test.js (6), auth.test.js (+2).

Doing: send to reviewer-2; agree the Connections view shapes with native-core; `view:` and `#connector` provider once platform's contracts reach stage.

Next:
- Rebase on stage/0.2 when vault-next lands; then add `mentions` (kind `connector`) and `view:` entries to module.json (platform's fields are not on this base yet).
- Deck Connections: `connectors.catalog` gives {presets:[{id,label,group,who,setup,modes,prefer,connected[],note,via}], unavailable}; `connectors.connect` answers step open|needs|via|connected.
- Google: decision pending on whether the BYO "Workspace only" presets ship (lead).
- GitHub: `via: "github"`, the github team's flow; the preset only supplies url, host binding and the PAT path.
- Slack/HubSpot/Asana BYO spike with a real person's app (Phase 2 rehearsal, not a test).
- Assistant caller identity (agentKind) may start a sign-in for the person once it exists; tokens stay person-only.

Needs from others: lead (Google ruling); native-core (Connections view); platform (`view:`/`mentions` on stage); vault (review of the shared hub/oauth changes).

Changed contracts: `mcp` gains a `boundFor` dep (lib preset binding) and passes `url` to `creds.headers`; `Credentials` gains optional `save`; `oauth.start` scopes optional, `offline`, `port`; `fake-mcp` gains `protectedBy`, function `requireAuth`; `fake-oauth` gains `rotate`.

---

## 0.1 record (kept)

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
- `vyre connect add google <name> --sign-in [--client <vault item>]` in
  `core/cli/commands/connect.js`: follows `/v1/events/stream?type=google.*&since=latest` (opened
  before google.connect, so no event is missed), takes a pasted address on stdin for
  google.connect.finish, cancels on Ctrl-C (or end of input only when stdin is a TTY), one 10
  minute timer and no polling. The browser opens only with dialogsAllowed() and a TTY. Tests:
  `core/cli/commands/connect.test.js` (9, six new: loopback, paste, missing client, refused
  flags, cancel on SIGINT, empty non-TTY stdin still finishing through the loopback).

## Doing

- Nothing in flight. Main has the hub, Google and the google.connect backend (d0e35c3, merged at
  53a994a). Waiting on the lead to approve the rest: the Deck sign-in form and admin-console
  helper (2483c77), the pre-opened tab fix (672b709) and the google.test description (7e03b8c).
  After main was merged back: 114/114 connectors tests green on the test box.

## Next

- Docs: patch for docs/using/connectors.md and docs/build/mcp-hub.md sent to the docs team
  (scratchpad docs-connectors.patch, against work/docs 502b97e). They apply it once the Deck
  form reaches main too.
- CLI `vyre connect add google <name> --sign-in` (prints the URL, waits for google.connected,
  takes a pasted address) if the lead wants it.
- The real-account Google run only after the user connects one himself.

## Needs from others

- Lead: whoever owns scripts/perf-check, on the first-sample flake.

## Changed contracts

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
