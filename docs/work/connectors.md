# connectors

Branch: work/connectors · Worktree: ../vyre-connectors · ADR: 0016

## Scope

Owns `lib/connectors/` (was `core/connectors/`, moved 2026-09-28), `core/mcp/`, `core/google/`, `core/mail/`, `core/cli/commands/connect.js`,
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

- LOAD RULE (lead): check `ssh testbox uptime` right before every run; run only under 6.
- RESUMED 2026-09-28: merged origin/main (794 commits, 0.1.0-rc.1/rc.2 landed) into work/connectors
  at 38a0240c. Conflicts: CHANGELOG.md (kept both entries), core/modules/index.js and
  modules.test.js (main's countUse/callerKind landed beside HEAD's meta.firstParty — both are
  independent and now compose in one `run` wrapper), docs/index.json + docs/reference/{events,
  index,tools}.md (took origin/main's generated files, then `node scripts/gen-docs-reference`
  regenerated them off the merged tree). Verified locally (not testbox, load was ~5.5-6):
  core/modules 41/41, connectors+mcp+google+mail+connect.test+harness.test 173/173,
  docs-build+docs-check+docs-index 50/50 — all green post-merge.
- New ask from the lead (0.1.1): every Claude Code MCP server (user/project/local scope, .mcp.json,
  plugin-provided) auto-discovered live in Vyre's Connections UI (not just one-time import), with
  status/tools/projects; multi-account native (two Gmail MCPs = one server, several vault-backed
  accounts, "add another account" is one click); per-project/surface on/off with secrets in the
  vault; Deck Connections view + compact Capsule list ("send from which account?"); live status
  events, no polling faster than 60s, optimistic toggle + Undo. docs/design/mcp-native.md written
  and sent to the lead (5 gaps, sized, build order). Gap 1 (discovery) built: core/mcp/discover.js
  (pure, tested with synthetic Claude Code config fixtures in temp homes, never real files),
  9af3a4fb. Not yet wired into `mcp.add`, `mcp.servers` or the Deck (own step, so a `pending` row's
  shape gets its own review before the UI depends on it).
- Fallout from the main merge: `test/boundaries.test.js`'s allowlist froze 2026-09-27 before
  connectors' on_behalf (behalf.js) and mail (message.js) edges landed. First fix (9af3a4fb) widened
  the allowlist; the lead corrected it: the allowlist only shrinks, and the integrator had already
  frozen these as connectors' 0.1.1 debt. Reverted, then did the real fix (lib move, below).
- `lib/connectors` (auth.js, message.js, behalf.js, testing/fake-google.js), moved from
  core/connectors: all three are stateless (injected deps or pure functions, no ctx, no I/O of
  their own), so they belong in a lib per ADR 0033, not behind an allowlist entry. Removes
  `core/google -> core/connectors` and `core/mcp -> core/connectors` from the allowlist entirely
  (26 frozen edges to 24); google/mail/mcp now import `lib/connectors/*` directly. Updated
  docs/architecture/boundaries.md and docs/adr/0033-hackable-vyre.md (item 2, done early, wider
  than planned).
- SAVED for restart 2026-09-27 (superseded by the above once mcp-native lands): handed to the
  integrator work/connectors 8be461a9 for the batch after batch 4; e2e signed off (84f630c9 + row
  text), platform approved kernel af11226d + test 77dcd644. Land together with vault 9b
  (work/vault-next, 5d7cbd07 or later: vault.connections.list {caller}, get, use) — still true,
  now against the merged tree.
- No testbox processes running.

## Next

1. mcp-native gap 2 (multi-account, native): once vault 9b's connections tools land on main, read
   them from deck/views/connections.js instead of mcp.servers directly, group rows by a stable
   same-server key (command+args, or url minus query), render accounts as chips, "add another
   account" pre-fills the same transport.
2. mcp-native gap 1 follow-up: wire discover() into a pending row surfaced by mcp.servers (or a new
   mcp.discovered tool), and an fs.watch (not polling) on the handful of config files so a server
   added to .mcp.json after Vyre started still shows up. Decide with the lead whether
   core/harness/rules.js's path walk should become a shared export before a third caller needs it.
3. mcp-native gaps 3-4: mcp.update scope toggle + vault grant/revoke wiring in the Deck card; the
   Capsule's compact account picker, with app-design, once 1-2 have a shape.
4. When vault 9b's sha arrives: real-vyred mail tests (IMAP, Apps Script, Google, two MCP
   instances) on top of it; hand the integrator the new sha.
5. Tell capsule-pro when mail is on main (they render mail.find rows, open the Gate card).
6. `vyre connect` for mail.map (CLI), and the Deck row for mail accounts (with pwa/native-core).
7. Platform's non-blocking note: cache config.home() in the registry; one firstParty definition.

## Needs from others

- vault: module-only vault.connections.list {capability?, caller} answering for that caller's surface; useOf send_mail/read_mail of every source -> mail.send/mail.search {account: id}; google-apps-script default capabilities send_mail+read_mail; take core/mail out of work/vault-next (6a0c0760).
- capsule-pro: Capsule rendering of mail rows.

- Lead: whoever owns scripts/perf-check, on the first-sample flake.

## Changed contracts

- KERNEL, its own commit af11226d for platform's review (lead OK): registry.call sets `meta.firstParty` from the loader's `firstParty(dir)`, taken verbatim from native-core 98412a66 (one rule), overwriting any passed value. Test in core/modules/modules.test.js.
- on_behalf needs meta.firstParty (anyone else is refused, code denied) and a real thread of the named agent (core/connectors/behalf.js), and sets who.person=false in the hub (e2e HIGH and MEDIUM 1, 2).

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
