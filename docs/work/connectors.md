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

- RESUME 8 (2026-09-28), finished the three items on the wave-1 list:
  1. Granting the Agents surface now goes through presence server-side, not just in the Deck.
     `vault.connections.grant` (core/vault/tools/connections.js) takes `presence(..., { when: input
     => input.surface === "agents" })`, reusing the same `presence()` helper vault.grant already
     uses; every other surface, and every revoke, stays a plain call. core/vault/connections.test.js
     covers both (a denied presence refuses `agents`, `capsule` grants and revokes go through with
     presence.deny still set). The Deck side (deck/views/connections.js) was already mid-rewrite
     from the prior session: withPresence wired into the Agents chip's toggle (Off until it
     resolves, aria-busy while asking, a shield glyph trailing the label while off), Capsule/Chat/
     Phone stay optimistic with Undo. Fixed two things that made the tests fail: the fixture
     (deck/fixtures/connections.json) had cn_alex missing "phone" from its granted surfaces and
     cn_tracker already granted "agents" (so the "starts off" test couldn't tell), and the shield
     glyph had no class for the "off" assertion to find — gave it `cn-chip-shield` (deck/css/views/
     connections.css already had the color rule for that class, just nothing used it yet).
     core/vault/connections.test.js 15/15, deck/test/connections.test.js 47/47 on testbox.
  2. app-design's review: the granted chip's "on" colour. `.cn-chip-on` in deck/css/views/
     connections.css already used `--focus`/`--signal-wash` (fixed in the same WIP before this
     resume) — confirmed correct against chip.md, no further change needed.
  3. e2e's LOW: `claudeJson(root, env)` (core/config/dialogs.js) ignored CLAUDE_CONFIG_DIR
     entirely, always reading `~/.claude.json`. Claude Code actually moves `.claude.json` inside
     CLAUDE_CONFIG_DIR when it's set (not just the `.claude` folder), so fixed claudeJson to look
     there too, same rule claudeHome already follows. core/config/claude-home.test.js's assertion
     flipped from asserting the old (wrong) behavior to the corrected one.
  Full run: core/config + core/mcp 70/70 on testbox before the connection dropped (testbox went
  unreachable mid docs-check run — one docs test result unseen, re-run before calling this final).
  Retested after the testbox resize (8 CPUs): docs-check caught docs/reference/tools.md gone stale
  from vault.connections.grant's new description; regenerated with `node scripts/gen-docs-reference`
  (no .js extension — the .js form 404s) and pushed as 0f0453b9. boundaries+docs-check 66/66.
- FIXED (06f92ad1): reviewer's MEDIUM on 9ca2c50a — `normalize()` in core/mcp/discover.js dropped
  env/header VALUES but kept `args` and `url` verbatim, and those are common places a key sits in
  plain text (`--api-key sk-...`, `?key=...`, `user:pass@host`). `url` is now reduced to
  origin+pathname (`hasSecrets` on query or userinfo); `args` has each secret flag's value
  (`--*token/--*key/--*secret/--*password`, next element or `=value` joined) replaced with the
  literal `[redacted]`, its own `hasSecrets`. New test with a planted key in both places
  (core/mcp/discover.test.js). core/mcp+core/config+boundaries+docs-check 137/137 on testbox.
  Still true: nothing calls discover() outside its own tests yet (Next item 1).
- Reviewer's LOW on 06f92ad1 (do with the wiring work, not now): SECRET_FLAG misses short/unusual
  flags (`-k`, `--bearer`, `--auth`, `--pat`; the comment overclaims `-k` already matches — fix the
  comment too) and a bare positional secret (`npx srv sk-ant-...`, no flag at all). Also redact any
  arg matching sync/scrub.js's PATTERNS token shapes (that file already knows what a real token
  looks like by prefix/entropy; reuse it rather than growing a second list here). Fold into Next
  item 1 (the pending-row wiring) alongside the reviewer's earlier MEDIUM.
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

## Platform gaps 0.2.9, items 5 to 8 (5 Oct 2026, work/connectors-029)
- A connector is a declaration: `records/connectors/format.js` (checkDeclaration, toCredentialConfig, declarationParts, serviceOf, buildRequest, parseResponse, readbackRequest, compareReadback). `kind` alone says outward (change, send, spend, delete); read and draft are not. Shipped: stripe, gmail, google-calendar (`records/connectors/index.js`). Stripe's webhook events come from its declaration.
- Vault: `service` in an api-credential keeps draft, idempotency, rate and ops, and vault.service.catalog hands them to Flows. `vault.service.forward` adds the declared idempotency header (derived from the idem key) on outward calls. Rate and Retry-After were already the vault's.
- Poll watchers: `watchers.preset { kind: "connector", connector, poll, credential, vars }` (core/watchers/connector-preset.js). One generic loop, read only, the plan is data in watch.js. `watcher.json` takes `memory: false`.
- Log communications: `records/comms/log-flow.js`, native steps only. `connectors.logging` returns the recipe (watcher input and stored Flow) and writes nothing.
- Credentials: `connectors.declared`, `connectors.declare` (a person's own, for a key or a service account). An OAuth declaration (`auth.type: "oauth"`) is an api preset whose sign-in makes the connector credential. Gmail and Google Calendar declare `auth.type: "google"` instead: they are signed in through the google module, and have no preset and no vault credential.
- Tools `records.roles`, `records.holders`.
- Calendar sync (core/daemon/calendar-sync.js, records/calendar/sync.js): live and default in every Space, two-way, on the declaration; outward writes are held for the owner's yes (a task, then the approved write with its approval and bind). Every Space defines the core types.
- One Google path (lead's ruling, 5 Oct 2026): the google module. The `google-api`, `gmail-api` and `google-calendar-api` presets, the vault credentials on the Gmail and Calendar declarations and the vault-connector branch of the calendar sync are gone. The calendar sync runs for every connected Google account through `google.api`; the Log communications watchers read Gmail and Calendar through the same tool (`net: { "gmail.googleapis.com": { "google": "<account>" } }`, GET only, never a write). A credential may still name several hosts, each service rule saying which (`host`), for the declarations that sign in the same way (`mergedParts`). Sign-in copy lives in the google module's tips: "Vyre can write drafts; sending asks you first".

## State at the stop order (5 Oct 2026)
Done and pushed: work/one-google (calendar-live + one Google path + GC-1..3 + approval fix merge + Event time zones + reviewer-4 hold fixes; at 49a566fca or later), work/project-files (merged work/one-chat; folders by chat id; project-file links chat-record; 1d711e682), work/def-watcher-r (def-watcher rebased alone onto devbox, 57e0b11d6), work/approval-repro (6cb1af49f, the stuck-approval reproduction, now fixed by platform-3's approval-token-verify).
Open: reviewer-4 verdicts on one-google, def-watcher-r, project-files. Full one-google suite on testbox6 was running (/tmp/og-full6.txt on testbox6; read its summary). Share to project (flows will send the call shape). Real-kernel chat-folder refusal test (flows' rule on hub-kernel-on). communication.contacts many-to-many relation in the Log-communications Flow (windows' relations, origin/work/spaces 140b6283f) is not built. one-google and def-watcher-r will conflict in watchers.preset (google input vs def-watcher's tool wrapper) when both merge.
Next step: read /tmp/og-full6.txt on testbox6, fix any red that is not baseline (watchers reach.test is fixed on def-watcher-r; reach-anyone flows.budget and boundaries daemon->sessions are not mine), then answer reviewer-4.
