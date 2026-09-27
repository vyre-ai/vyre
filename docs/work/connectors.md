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
- Read app-design's Connections board (docs/design/one-app/project/Connections.dc.html, db3dbbfa
  in work/app-design): corrected my own read of "multi-account, native" (mcp-native gap 2). It is
  NOT a grouped card with account chips inside it: every connection (Google, mail, Apps Script, an
  MCP server) is its own flat card, same shape. Two Gmail MCPs are already two vault_connections
  rows (vault 9b's resync), so they are already two cards, each its own "Granted to" chips and its
  own "Wrong account?" link; "Connect another account" is the one add-affordance for all of them.
  Simpler than what I'd sized in docs/design/mcp-native.md gap 2, no grouping-by-command-line logic
  needed.
- Built the first slice: `pickConnections()` in deck/views/connections.js (30/30 with the file's
  existing pickers on testbox), a pure vault.connections.list -> card-fields mapper. Not wired into
  drawConnections yet: it reads mcp.servers/google.accounts directly today, and the real markup
  needs app-design's card.md/chip.md to have a Connections row (both still draft/partial, no
  Connections implementation listed) before I build a one-off version of their CSS.
- Found a live mismatch, not guessed around: the board's grant chips are Chat, Planner, Agents;
  vault-next's real SURFACE_NAMES are capsule, chat, agents, phone. No Planner surface exists to
  grant today. Filed below rather than inventing a chip that grants nothing.
- e2e reviewed 21beb66b (merge + design doc + discover.js + lib/connectors move) and signed off for
  0.1.1 batch 1, with two MEDIUM conditions before discover is wired anywhere: (1) discover() must
  never return an env/header VALUE, names + hasSecrets only; (2) `userHome` must come from the
  kernel's rule (a new `claudeJson(root, env)` beside `claudeHome` in core/config/dialogs.js, both
  exported from index.js), never `os.homedir()`, so a dev/temp/trial home never reads the real
  `~/.claude.json`/plugins. Both fixed (9ca2c50a): normalize() keeps envNames/headerNames only;
  discover({ root, env, cwd, plugins }) reads through claudeJson/claudeHome, plugin scan added
  (`<claudeHome>/plugins/*/.mcp.json`), guard test in core/config/claude-home.test.js. Documented
  in discover()'s jsdoc: whoever wires this into a tool must pass the caller's verified project as
  `cwd`, never a path from the tool's input.
- Merged work/vault-next (63 commits, b93d0b1d): real vault.connections.* now in this tree. Wired
  `drawConnections` (the lead's "wire it now," unblocking on both open questions: CSS built from
  production tokens directly, chips are the real four surfaces, no Planner) — see the changelog
  entry for the shape. 347/347 targeted + docs on testbox.

## Next

1. mcp-native gap 1 follow-up: a `pending` row for a discovered-not-added server (surfaced by
   mcp.servers or a new mcp.discovered tool), wired with the caller's verified project as cwd (not
   from input, per e2e), and an fs.watch (not polling) on the handful of config files so a server
   added to .mcp.json after Vyre started still shows up.
2. A real "Sign in again" flow for a problem card (today it draws a Sign in button that does
   nothing): needs app-design's read on the flow and which tool fixes a needs_credential row per
   provider (vault.connect for a generic need; google.connect for Google specifically).
3. mcp-native gap 4: the Capsule's compact account picker ("send from which account?"), with
   app-design and capsule-pro, once app-design has reviewed the Deck card.
4. Ask app-design to review deck/css/views/connections.css's card/chip CSS (built ahead of
   card.md/chip.md having a Connections row, the lead's call) and fold it into the shared
   components once they exist, or tell me to change it now.
5. When vault 9b's sha (now merged here) lands on main: real-vyred mail tests (IMAP, Apps Script,
   Google, two MCP instances); hand the integrator the new sha.
6. Tell capsule-pro when mail is on main (they render mail.find rows, open the Gate card).
7. `vyre connect` for mail.map (CLI), and the Deck row for mail accounts (with pwa/native-core).
8. Platform's non-blocking note: cache config.home() in the registry; one firstParty definition.

## Needs from others

- app-design: review deck/css/views/connections.css's card/chip CSS, built from raw tokens ahead of
  card.md/chip.md having a Connections row (the lead's call, 2026-09-28). Also: the board's grant
  chips show Chat, Planner and Agents; is Planner meant to become a fifth vault SURFACE_NAME (a
  real grant), or does it mean something else there? And the real "Sign in again" flow for a
  problem card (today's Sign in button does nothing).
- vault: does "expired" (app-design's board shows a Stripe MCP row expired 3d ago) get its own
  state, or does it fold into needs_credential? Which tool fixes a needs_credential connection's
  credential from the Deck (vault.connect? something per-provider)?
- capsule-pro: Capsule rendering of mail rows; the compact account picker (mcp-native gap 4).

- Lead: whoever owns scripts/perf-check, on the first-sample flake.

## Changed contracts

- KERNEL, 9ca2c50a (e2e review, not yet a separate sign-off): `core/config/dialogs.js` gains `claudeJson(root, env)` beside `claudeHome`, exported from `core/config/index.js`. Same real-vs-dev rule as claudeHome, for the file (`.claude.json`) that sits beside the folder rather than inside it. Test in core/config/claude-home.test.js. Flag this one to platform/whoever else reads core/config, since it is the second connectors change to a kernel file this batch (the first, firstParty, already got its own review).
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
