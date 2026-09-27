# polish-cli

Branch: work/polish-cli · Worktree: ../vyre-polish-cli · Owner session: polish-cli

## Scope

Driving Vyre from the terminal feels as native as Claude Code's own. Owns `core/cli/screen/`,
`core/cli/kit.js`, `scripts/stress-drive`, and the consistency pass over `core/cli/commands/*`.

1. `vyre` with no arguments: one live screen. Inbox (held drafts, open asks), projects, sessions
   and agents on the left; the selected session's output streaming on the right.
2. Every command: same verbs, `--json` on every read, exit codes 0/1/2, errors that name the
   next step, no stack traces, `vyre help <cmd>`.
3. `scripts/stress-drive`: 4 headless threads for 30+ minutes on the fake Claude.

## Done

- Install size (lead's top priority, user said yes): `npm i -g vyre` 750 MB -> 5.9 MB on disk
  (4.5 MB of files), tgz 1.50 MB before and after, measured on the test box from `npm pack` into an
  empty prefix. The embedder is fetched on first use into <VYRE_HOME>/embedder (pinned
  transformers 4.3.0, pruned 500 -> 105 MB), keyword search until then, `vyre recall --setup`
  to fetch now (16 s on the test box, real network, temp home). Tests: core/recall/embed-install.test.js
  (fake npm, no network). The 2 MB target: the rest is Vyre's own code, deck and docs.

## Done (2)

- vyre update keeps the pending onboarding link (lead's add): `vyre up --keep-link`,
  `onboard.link {mint:false}`, link hash and sessions survive a vyred restart. Tests:
  test/onboard.test.js (restart survival), core/cli/commands/up.test.js. 
- Commit stamp (lead assigned it to me): build.json from build-site.sh; /v1/health, system.info,
  vyre status. Test core/daemon/build.test.js.

## Done (3)

- `vyre threads` empty states (6d1c4cf); `--help` crash was main-only, fixed by the kit branch.
- One vyred per home: vyred.lock in the real folder, socket from the real folder. Tests
  core/daemon/lock.test.js; checked with the real CLI on the test box through a symlink.

## Done (4)

- `vyre up` restarts a vyred on another build (d310169): "updated · restarted vyred (old → new)",
  stops only the pid both the pid file and health name. test/upgrade.test.js.
- The ending's assistant line says `vyre assistant <name>`; new `vyre assistant` (d310169).
- `vyre box update` and doctor print `npm install -g https://vyre.run/box/vyre.tgz && vyre up`
  (INSTALL in core/cli/brand.js); the known gap is closed in box-care, troubleshooting, known-gaps.
- No-nag: memory.correct/merge/split drop presence; agents and MCP stay refused (ownerWrite and the
  callers list), silently. Targeted tests 64/64 on the test box.

- Vault sessions (lead's decision): a presence session covers vault.reveal/copy/totp/approve/grant
  for the Deck and the Capsule only; the CLI proves every `vyre vault` reveal or grant; MCP and
  agents refused. The in-memory per-device window from the WIP commit is gone.
- learn.accept/retire/relax ask no presence (off the floor's list); the harness floor still
  denies a model's shell naming them (MODEL_NEVER in core/harness/rules.js).
- Stress: warmup is half the run. The 20 min rerun had a flat JS heap (0.69 MB/10 min) and RSS
  81 -> 94 MB by 15 min, then flat for 5 minutes: warmup, not a leak. The 40 min confirmation run
  was stopped at 12 min on the lead's word (testbox load).

## Done (5), after logout 3 (the CLI is first-class)

- The CLI's 30-minute window (998c2a1, narrowed by the lead's decision): one Touch ID, Capsule or
  passkey proof from a login covers that login's vault.approve and vault.grant only
  (TERMINAL_WINDOWED); reveal/copy/totp/run and gate.approve ask every time (keystroke injection:
  tmux send-keys, AppleScript; ADR 0004 addendum). Each use: a line on that terminal and a
  vault_audit row. No secret on disk: vyred keys the window on the terminal the kernel
  names (socket peer pid -> controlling tty -> listed by `who`), after e2e's ancestry check, so
  anything under claude, detached, or in a script pty never rides it. Bound to the login (tty +
  leader pid + start), so a reused tty starts fresh; a tmux pane rides it when every attached
  client is in such a login with no claude above (core/daemon/peer.js loginOf, tmuxClients).
- Verb parity: `vyre needs`, `vyre gate` (drafts), full `threads answer`, live `vault totp`
  countdown + vault health/breach/history/revert/clear-clipboard, `vyre phone add|list|remove|test`
  (dependency-free QR in core/cli/qr.js), planner edit/rm/ringing/dismiss, agents
  history/resume/computer, --json on learn/connect/hooks/send.

## Doing

- Release-candidate sha to the integrator: the HEAD after the runs below (all with VYRE_CHECK_VIEWS=1,
  load under 6, nice 15, --test-timeout): 189 (view, tip line, consistency, cli, threads-sessions,
  apps, voice, statusline, sessions, needs, box, term, projects, sideview, docs) then 74/74 after
  fixes; 218 (every other core/cli/commands test, vault-cli*, link-cli, peer, presence-cli, memory
  correct, recall module, statusline) then 15/15 after fixes. Fixes from the runs: card states
  outside CheckState (gate held, recall off, agent computer off), apps sample names, docs:ref.
- Batch 4 had 4bc5c14b.

## Next

0. Render: platform took our fields, prompt flat (work/platform b5145ee1, local until pushed).
   view.js renderProblems mirrors it at run time (VYRE_CHECK_VIEWS=1 in tests); when the d.ts is
   on main, add the JSDoc type import too.
   vyre key (cohesion 6): thin verbs over vault.need / vault.connect once work/vault-next lands;
   vault-next already has `vyre vault need|connect` in vault.js, which will conflict with our
   vault.js views (d035a46c): merge carefully. voice key becomes an alias.
   Statusline: e2e's config.claudeHome switch (work/e2e-noclaude 32dc0956) when it is on main,
   plus a temp-home test. vyre config: after native-core's settings land (tips.enabled and
   tips.gap_minutes come from core/tips/module.json settings).
   Capsule-pro's first 10: voice status, status, doctor, threads list, phone add, vault list,
   timer/remind, agents list, projects list, config get/set: check each --view frame by hand.
   Follow-ups from subagents: core/cli/presence.js should refuse /dev/tty under --view itself
   (personIO() in commands/presence.js works around it); verbs.js could split `[--a|--b]`;
   link team: signin loopback outlives stop, second pair leaves the first waiting.

1. Batch 4: send the integrator the sha after merging main (7d2f9c32 or later).
2. `vyre config`: once native-core's settings are on main, take over config.js/config.test.js
   (77faf1e3, server side 42dcb98c) and make the nine review fixes with tests (see below).
3. Module command dispatcher (ADR 0033 P4) when platform sends its P1 sha: GET /v1/modules rows
   `commands`, input schemas and presence from GET /v1/tools; review platform's module.js/update.js.
4. The 30-minute stress check at nice -n 19 when the lead says testbox is quiet (after a deploy).
5. Sessions: the queue drops images (still true on main 7880dfa6: queue() takes no images);
   switch the CLI's refusal off when fixed.
- After 3a (sessions) lands: merge main, resolve modules/index.js, presence (PERSON_ONLY union),
  switchboard.test; targeted run; send the integrator the sha (batch 3b).
- Modularity: core/cli/qr.js -> deck/vendor/qrcode.js is an OK'd allowlist entry (lead: a
  third-party vendored lib; platform moves it to a shared vendor/ later). When ci-boundaries is on
  main, add it to test/boundaries.test.js and docs/architecture/boundaries.md (or the integrator at
  the batch 4 check).
- threads.queue {thread} when sessions ships it (asked).
- Session verbs follow-ups when work/sessions lands: threads.send `mode`, queued_id, a queue read,
  the unqueue/edit/send_now/rewind tools, thread.turn/state/usage payloads (7 gaps sent to sessions).
- pwa's push.subscribed / push.delivered / push.seen {standalone}: wire them into phone.js checks.
- Session verbs: start, send, send-now, queue edit/drop, stop/interrupt, take back, open in
  terminal, watch, all with --json, once sessions answers.
- `vyre phone add`: the relay is the default (lead). Built against work/relay 0dfbd12 (path, rtt,
  node, device.moved); retest once relay lands on main. A Mac is sent to the box/Deck to pair
  (ADR 0032: link.call refuses human-only tools). One QR encoder: asked relay to use core/cli/qr.js.
  Still missing box-side: push.subscribed event, push delivery ack, an APK the box serves.
- When the integrator says testbox is free: a 30 min stress run at nice -n 19 to confirm the
  second-half RSS slope is under 1 MB/10 min.
- Deck/Capsule clients: to ride a session for approve/grant they need e2e's
  `x-vyre-presence-keep` (work/e2e 043123a) or presence.session.open. Deck team's call.
- capsule-now to call capsule.report from the app (asked); then doctor's Capsule line is real.

## Needs from others


- tailnet: `link.health` shape for the status line (asked).
- connectors: `vyre connect` conventions and any tool the screen should show (asked).

## Changed contracts

- presence (owner: e2e/security): Presence.verify takes `terminal`; Registry.call passes it;
  vyred's socket route sets it (atTerminal) for cli/local callers of SESSIONABLE tools.
  peer.js gains controllingTty. PERSON_ONLY gains agents.resume.
- agents (owner: agents): agents.resume is callable by cli, local, deck, capsule (not only
  modules); `thread` optional (the latest), checks ownership, leaves a running thread alone.

- presence (owner: e2e/security): SESSIONABLE gains vault.approve, vault.grant; a session proves a
  vault.* tool only for deck, capsule or tailnet-owner callers. HUMAN_ONLY loses learn.accept,
  learn.retire, learn.relax. Merge note: work/e2e also edits the SESSIONABLE line (adds
  gate.approve) and adds PERSON_ONLY/MODEL_NEVER in core/harness/rules.js; take the union.
- vault (owner: vault): vault.approve and vault.grant declare `session: () => true`.
- learn (owner: learn): accept/retire/relax drop their presence declarations.
- harness (owner: harness): rules.js MODEL_NEVER = HUMAN_ONLY plus the three lesson tools.

- memory (owner: memory/recall team): memory.correct, memory.merge, memory.split no longer
  declare presence (their summaries are gone). docs/using/memory.md says so.

- link (owner: link/tailnet): link.find and link.pair refuse `not_real_home` on a temp home
  (config/dialogs.js realBoxAllowed).
- recall: the model runs in embed-worker.js via spawnEmbedder; recall.status gains `progress`;
  config recall.duty, recall.lowBattery. perf-check --first-run.
- daemon: /v1/health gains `memory`.

- presence (owner: presence): `presence.keys` rows gain `rp_id`.
- tailnet: `core/cli/tailnet.js` `status(env, {timeout})`, parse adds `magicDNS`, `certDomains`.
- capsule (owners: capsule-now/capsule-pro): new tool `capsule.report {ok, message}` emitting
  `capsule.hotkey`. Asked capsule-now to call it from local/capsule/app/main.js on every hotkey
  state change; until then doctor shows "?" for Capsule permissions.

- onboard (owner: onboarding team): `onboard.link` takes `{mint:false}` and then returns
  `{url:null, pending, expires, port}`; loopback keeps hashes in <VYRE_HOME>/onboard-link.json.
- box/vyre: `update` ends with `cli up --keep-link`.
- daemon (owner: core): start() takes <real home>/vyred.lock first; config.socketPath uses the
  home's real path.
- daemon/system: /v1/health and system.info gain `commit`, `dirty`; scripts/build-site.sh
  stamps build.json; package.json files gains build.json.

- recall (owner: recall team): `package.json` has no optionalDependencies; `core/recall/embed.js`
  installs the library on first use (`install`, `installed`, `load({ runtime, npm })`, `PACKAGE`,
  `RANGE`, `DOWNLOAD_MB`); new tool `recall.setup` in module.json; `recall.status.vectors.ready`;
  config `recall.embedder`, `recall.npm`. docs/work/recall.md still says "optionalDependencies".
- ci/release: `scripts/release-check.sh` asserts no optional deps and an install under 10 MB.
- learn (merge): the learn CLI uses kit exits, so a refused presence is 3 and a usage slip 2
  (test/cli.test.js updated).
- Known, not mine: core/cli/commands/box.test.js "sudo with a password ... docker group" fails
  on the test box (its user is already in the docker group, so the step is never offered).
