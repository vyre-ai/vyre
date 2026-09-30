# capsule-sight

Branch: work/capsule-sight · Worktree: ../vyre-capsule-sight · ADR 0015 (claimed in README.md; capsule-pro moved to 0017, so the numbers no longer clash)

## Scope

1. Screen context from AX (`local/screen-mac`, tool `screen.context`, `screen.shot`).
2. Mac computer use with presence on Send/Post/Pay (`local/hands-mac`, `hands.act`, `hands.commit`).
3. Side view: any session in a panel on the left (about 29% of the display) and Chrome (local,
   or Glass for the box) filling the rest, tiled natively in one gesture
   (brief: team/briefs/sideview-layout.md).
4. Voice: push-to-talk with the Deepgram key from the vault through vyred (`local/voice`).
5. The Capsule half of all four, built into capsule-pro's extension seam
   (`local/capsule/native/Sources/Extensions/sight/`, protocol in capsule-pro's
   `Sources/Kit/Extension.swift`).

## Done
- (claim ADR) ADR 0015 claimed, the floor list (places Vyre never reads or touches), test-owned window.
- (hands) hands: the whole Mac inside the floor, overlay indicator, stop key, commit needs presence.
- (screen) screen: screen.context from AX notifications with a long-lived sight helper, screen.shot.
- (voice snapshot) voice module (lead snapshot): status, settings, speak, the listen stream, mic helper.
- (test(screen) fake-helper) screen tests run on the test box (fake helper, platform darwin). screen 20/20, hands 42/42.
- 201c417 sideview: `local/sideview` + `vyre-tile` + `vyre sideview`. the test box 21 pass, 1 skip (real Mac).
- 9245826 voice: `vyre voice`, `vyre voice key`, `vyre voice status`. the test box 20 pass, 1 skip.
- ADR 0015 written (docs/adr/0015-capsule-sight.md).
- Terminal tabs on chat's recall.watch (work/chat 10604b9 shapes): history from recall.thread,
  then recall.watch from the last turn id, rows deduped on id (text and "tool:<id>"), tool turns
  as tool lines settled by the next turn or busy false, session.state drives the dot, renew every
  60 s while shown (restart from the last id on not_found), recall.unwatch on tab switch or close.
  Reply labels by chat's labelFor rule (ReplyLabel.of; system.info read once per show). Combined
  tree = work/capsule-pro 834b28e + this branch: 242 pass / 0 fail. Also fixed an ordering flake
  in the screen attach collapse test (async let has no start order).
  Perf: not measured on a live Capsule (no app launch without the lead); cost is one
  recall.watch call a minute while a terminal tab is shown, nothing when hidden.
- 9033c47 sight extension in Sources/Extensions/sight: side view commands, Ask about my screen,
  Option-Return push-to-talk. 12/12 sight tests in a combined scratch copy of capsule-pro's tree
  (174 pass, 1 fail: capsule-pro's own contact-photo icon test).

- Real-vyred perf check on the Mac (2026-09-27, main ef51363 merged as 1449b5d; capsule-pro
  b76552d + this branch's sight, stale askItem line dropped in the scratch copy only). A temp
  home under the test SCRATCH (HOME and VYRE_HOME both), VYRE_NO_DIALOGS=1, fake Tailscale, the
  Mac modules capsule/hands/screen/sideview/voice disabled, recall vectors off; 41 sessions,
  8,300 turns. The real SessionPanelModel + SessionPanelView in one offscreen, unfocused
  "vyre-test" window, following a terminal session through recall.watch. Run through buildlock.
  | Phase | vyred CPU avg / p95 | vyred RSS | panel CPU avg / p95 | panel RSS |
  |---|---|---|---|---|
  | A vyred alone, 60 s | 0.017% / 0% | 110 MB | | |
  | B tab shown, idle, 90 s | 0.022% / 0% | 110 -> 93 MB | 0.066% / 0.66% | 68 MB |
  | C a turn pair every 2 s, 60 s | 0.099% / 0.67% | 93 -> 89 MB | 0.63% / 1.33% | 67 -> 68 MB |
  | D tab closed, 30 s | 0% / 0% | 90 MB | | |
  First show (history + watch) 304 ms. 29 of 29 appended turns drawn, append-to-row p50 27 ms,
  max 28 ms. After close: recall.status watches 0 (the unwatch landed), panel exit 0, home removed.
  p95 figures sit at ps's 10 ms tick (0.67% of a 1.5 s sample). The window was offscreen, so
  compositing is not in the panel number; the SwiftUI updates are. The panel RSS is a harness
  carrying the whole Capsule codebase, not the Capsule's own footprint.

## 0.2 (30 Sep, lead's GO): computer use and Chrome control
Plan: team/0.2/plans/capsule-sight.md (with its Review response section). Build order there:
steps 1-3 first (outward classifier, Gate wiring, the one grant), then deep Chrome control.

### Done
- Build steps 1-3, e0e39546 (then merged with main's ADR 0036 thread/call/agent labeling, 74642d2b):
  - floor.js: outward() is a substring/localized-word classifier (English, German, Spanish,
    French, Portuguese) over the label and AX identifier, not an exact-word regex (reviewer-2 B1).
    Return in a browser's text field is held too (BROWSERS + TEXT_ROLES), on the safe side until
    deep Chrome control can see the real DOM.
  - hands.js/index.js: an unasked outward act holds through the Gate (kind "act", a new sender
    "hands:mac", gate.offer/gate.request) instead of the old bespoke hold-and-commit path. Held
    content carries the whole input plus signature(before); hands.release (module:gate only)
    re-checks that signature and refuses "changed" if the screen moved before replaying the act
    (reviewer-2 H1). hands.commit stays as a direct, presence-gated path for a caller that wants
    to drive the approval itself.
  - grant.js: hands.grant.list/add/remove. A named agent (mcp:agent:<name>: box-side, the
    assistant, or an ACP provider once sessions ships one) may drive this Mac's
    hands.observe/find/act/commit only once granted, on the Mac, with presence (reviewer-2 H2).
    The person's own direct session is not gated.
  - gate.js/gate/index.js: KINDS and OUTBOUND gain "act".
  - Tests: local/hands-mac 59/59, local/screen-mac 23/23 (one real-window test flakes alone under
    load regardless of this change, confirmed by running it against unmodified floor.js too;
    passes solo), core/gate 30/30, docs-check and the tools-reference test clean. All run on this
    device's node --test, temp homes, never the test box.
  - Merge with main's concurrent ADR 0036 (thread/call/agent event labeling via AsyncLocalStorage)
    resolved by hand: kept both the ALS-based `emit` and the explicit `(input, meta)` plumbing my
    grant check and gate.request's `thread` need. module.test.js's own thread/agent test needed a
    `hands.grant.add` call added first, since "kit" is now an ungranted agent name by default.

### Done (deep Chrome control, ADR 0049, a55b5480)
- One extension (local/hands-chrome-mac/extension, MV3, fixed manifest key so the id is stable):
  shell (background.js), lib (cdp, ctx, floor, err), caps tabs, page, batch, devtools, net, api, ghl,
  shared/ (proto, redact, apilearn). Static imports only (a worker forbids import()). Vault adds
  caps/vault.js with register() from caps/index.js.
- Module `chrome` (local/hands-chrome-mac/index.js): chrome.tabs/snapshot/act/fill/eval/wait/screenshot/
  batch/inspect/sources/console/net/api/ghl/state/plan/interject/stop/resume/status/install plus the box
  module's chrome.click/type/open shapes. Grant table shared with hands, Gate kind "act" sender chrome:mac,
  URL floor tier on both sides, second redaction pass on arrival.
- Native host + installer (native-host/), bridge over a unix socket or named pipe, oversight state machine
  (plan first, interject deliver-once, Esc idempotent and immediate, resume only after an answer).
- Redaction (extension/shared/redact.js): cookies, tokens, session ids, CSRF, keys, passwords, JWTs masked
  by name and shape in headers, URLs, bodies, storage. No argument returns a raw value.
- Speed design: one attach per tab, page.fill in one evaluate, batch.run and ghl.run as ONE host round trip.
- Proof harness: .github/workflows/chrome-spike.yml (macos, windows, ubuntu), spike/, bench/ (checkout and
  GoHighLevel-shaped fixtures, --direct-cdp baseline). Not run yet: needs the branch pushed.
- Tests: 262 in local/hands-chrome-mac and local/hands-mac, all fake-only, 0 fail. docs-check, module-sdk
  and tips tests clean.

### Done (30 Sep, reviewer-2's invisible-guard list, one commit)
- Password-field guard (extension/shared/guards.js) on page.eval AND dev.console.eval: type=password, autocomplete
  current/new-password, a "show password" field switched to type=text (by name, id, label, placeholder), open
  shadow roots and same-origin iframes. Closed shadow roots and cross-origin frames are unreadable to a script too.
- Console ring and sources cache purged when a page's execution contexts clear (any navigation, reload), so a blind
  page leaves nothing behind. Broader than "blind navigation only": a normal reload also clears the console, as
  DevTools does by default.
- net.list and records() (api.learn) filter by the floor tier with the person's own blind list, read once per call.
- "replaced" (a second connection took over) is emitted as chrome.replaced, a quiet event, never a prompt.
- Pinned-origin comments reworded (bridge.js, host.js, index.js): a sanity check, not authentication.
- Seeded bridge fuzz (bridge-fuzz.test.js, VYRE_FUZZ_SEED): garbage bytes plus hostile frames from a connection and
  from the live extension; bridge keeps serving, nothing uncaught, no prototype pollution. Seeds 1,2,3 and the default pass.
- Socket path confirmed: <VYRE_HOME or ~/.vyre>/run/chrome.sock (VYRE_CHROME_SOCK overrides). The shell-rule line in
  core/harness/rules.js is harness's file: sent to platform.
- Standing permissions: the vault Gate (work/vault-next) matches inside gate.request and releases at once, BEFORE
  gate.request returns an id. That would have failed chrome.release and hands.release (record keyed by id). Both now
  file the record under a random single-use ref carried on the card, look it up by id or ref, and return the
  released result to the caller (state "sent") instead of a held answer. Tests: module.test.js (chrome), control.test.js (hands).
- Tests: local/hands-chrome-mac + local/hands-mac 285 pass, 0 fail; docs tests clean.

### CI on 3963b50c (run 36665788234), read 30 Sep
- spike and direct-CDP bench PASSED on macOS, Windows, Linux (Chrome 154, headless new, extension loads and says hello,
  native host round trip p50 macOS 3.3 ms / Windows 2.0 / Linux 6.3; direct-CDP bench p50: snapshot 0.5-1.0 ms, page.fill
  of 12 fields 0.4-0.75, click 1.3-2.1, 20-step batch as ONE call 1.5-1.9 ms vs 20 sequential calls 31-48 ms).
- The REAL extension run (spike/harness/real.mjs: batch through the product and the Esc halt number) produced NO numbers:
  the step printed nothing for 15 min on all three OSes and hit the job cutoff. Batch and Esc-halt figures for the real
  extension therefore do not exist yet. Fix in the next push: stage logging to stderr, 120 s per stage, 240 s for the bench,
  5 s on closing the bridge and fixture, a 400 s watchdog that writes partial results, 8 min step timeout.

### Standalone vyre-chrome (30 Sep, user's decision: Chrome ships first, no Vyre server)
- local/hands-chrome-mac/standalone/: runtime.js (hosts the SAME chrome module with a small ctx: no Gate, held sends
  return an id and chrome_send does them, so Claude Code's own permission is the approval), mcp.js (stdio JSON-RPC, tool
  names with underscores), cli.mjs (install, uninstall [--purge], mcp, status, report, logs on|off|path|shots), trace.js
  (JSONL per session in ~/.vyre-chrome/logs, redaction, 100 MB cap, report), build-release.mjs (folder + tar.gz + sha256,
  imports checked to stay inside the package), README.md, GHL-PLAYBOOK.md, harness/real.mjs (real Chrome + real extension +
  the built package over MCP), workflow .github/workflows/chrome-standalone.yml.
- caller.js replaces the module's only import of core/modules (parity test). Native host launchers read a sock-path file.
- Fixed on the way: the module treated "no_such_tool" from hands.indicator as a failure (vyred without hands); a batch of
  fixture-side bugs in the old fuzz test; stand-in Gate in module.test.js is first party (stage/0.2 default-deny).
- GHL hardening (subagent, 2f7d074c): waiting helper, popup allowlist, stale retries, fuzzy-but-safe labels, verified saves
  (ghl.save), flows, trace + failure DOM snippet in every result.
- Tests: 390 pass locally in chrome/hands/docs/boundaries; CI on the runners is what proves real Chrome and is NOT read yet:
  needs a push of work/capsule-sight (runs chrome-spike.yml and chrome-standalone.yml).
- Release: node local/hands-chrome-mac/standalone/build-release.mjs --out dist (also the `package` job's artifact).

### Real-use findings (the user's own install)
1. 30 Sep: `zsh: command not found: node`. Node is under nvm and a login shell has no node on PATH. Fixed: a `vyre-chrome` launcher script
   (and vyre-chrome.cmd) at the top of the package finds Node 22+ itself (PATH, nvm, Volta, fnm, asdf, Homebrew, /usr/local); install puts
   it in ~/.local/bin (symlink) and prints how to add that to PATH; the README leads with `./vyre-chrome install`. Tested with PATH=/usr/bin:/bin.

### Doing
- Waiting on a push of work/capsule-sight to run chrome-spike.yml on the runners (now includes spike/harness/real.mjs: the real extension + host + bridge, the bench, stop-halts-batch and blind-refused checks).
- Esc: hands.indicator (new hands tool) raises the shared pill before every Chrome act, and the hands overlay's stop (Esc or double Control) stops Chrome control through oversight.

## Next (when resumed)
0. Read the chrome-spike results (spike, direct-CDP bench, real.mjs) per OS, fix what the real Chrome shows.
1. Read the spike results (headless new + load-extension + native messaging on mac/windows, attach cost,
   round-trip p50/p95). If headless cannot load the extension, run headed under xvfb/the runner desktop.
2. Real-extension mode: bench/bridge-connect.mjs (starts bridge.js, waits for hello, call/close), align
   extension-driver's step shapes with page.act/page.fill, run the checkout and GHL fixtures through the real
   extension on the runners. Put the measured per-step and 20-step-workflow numbers here.
3. Oversight UI seam for capsule-pro: events chrome.plan, chrome.step, chrome.interjected, chrome.stopped,
   chrome.resumed; tools chrome.plan/interject/stop/resume. Esc key wiring: hands' overlay already owns the
   stop key on the Mac; make its stop also call chrome.stop.
4. Vault: tell vault the caps interface (register(), ctx.storage, the shared/ redactor). Their fill, save and
   API-key capture become caps/vault.js.
5. Guided load-unpacked install screen (waits on app-design); Windows registry install runs on the
   windows-latest runner.
6. GoHighLevel: flows and labels are unverified against a live account. Acceptance is a live run by the
   person; the fixture proves machinery and speed only.
7. Reviewer-2: the extension is a new privileged surface (debugger permission, native host, redaction).

## Try it (the user, own terminal, a vyred from this worktree in a separate home)
    cd <vyre-dir>/vyre-capsule-sight
    <team-dir>/buildlock.sh capsule-sight sh local/sideview/build.sh
    export VYRE_HOME=/tmp/vyre-sight VYRE_ALLOW_DIALOGS=1
    ./bin/vyre sideview            # --url U, --ratio 0.33, --glass <agent>; ./bin/vyre sideview close
    set -a; source <vault>/.env.vyre; set +a
    printf %s "$DEEPGRAM_API_KEY" | ./bin/vyre voice key
    ./bin/vyre voice               # Enter to talk, Enter to stop, Ctrl-C to quit

## Needs from others
- Gaps closed on work/sessions d12171cc (batch 3a): thread.tool status "canceled" for calls a turn
  left open (phase stays); thread.state carries turn and has "failed" {turn, error}, then idle.
- LANDED on work/sessions b8b1a0a7 (not main yet), final shapes, which differ from the agreed ones above:
  thread.tool {id (= call), call, tool, name, phase started|done, status running|completed|failed
  (no canceled), block, summary, destination, turn}; thread.state {state starting|running|waiting|
  idle|stopped} once per change (no failed, no turn); thread.turn {turn "<thread>:<n>", uuid, text};
  also thread.usage and thread.steered. threads.get unchanged; its events list carries these too.
- sessions (ADR 0030), agreed shapes, not landed yet (after the SDK default flip; sessions sends
  the commit): thread.tool {id (= call), call, name, status running|completed|failed|canceled,
  summary, turn}, running once then one final status; thread.state {state starting|idle|running|
  waiting|stopped|failed, turn}; thread.turn {turn "<thread>:<n>", uuid, text}. Live in 33ae9e7:
  thread.started carries provider, model, auth, purpose; thread.stopped reason "idle" means
  resumable, not ended (the panel must not mark the tab closed), or "restart". threads.get keeps
  today's shape for Claude sessions (history stays in the transcripts); later fields are additions.
- LANDED: chat's recall.watch on work/chat 10604b9. Final shapes: recall.watch {session, from?, watch?}
  -> {watch:"w_<hex>", session, from|null, busy}; renew by passing watch (renewed:true); expires 3 min
  unrenewed, 30 min idle; not_found. recall.unwatch {watch} -> {watch, ended:true}. session.turn
  (thread = session id) {session, id, seq (transcript LINE), turn?, role, text, tool?, at, replay?}:
  dedupe on id (text turn id = recall seq as string, tool turn "tool:<id>"; recall.thread items now
  carry id and at). session.state {session, busy} only on change. Callers include capsule.
- chat: `recall.watch {session, from?, watch?}` (renew by id; expires 3 min after last renew,
  30 min idle, recall.unwatch), `session.turn` {session, id, seq, role, text, tool?, at},
  `session.state` {session, busy}; system.info.assistant.name (work/chat 45557bf). Being built.
- capsule-pro: 911c270 merged (834b28e). Their tip does not compile alone:
  Sources/Agent/AgentDestinations.swift:47 calls askItem(q), gone since 013e4e6 (b491743 brought
  the call back). I dropped the line in my scratch copy only.

## Standing rule (user, 2026-09-27)
- Vyre must not nag: the user runs on bypass permissions. No prompt or Touch ID for the person's
  own actions. Touch ID only for pairing a new device, vault secrets, and sending, posting or
  paying outside; one Touch ID lasts about 30 minutes per device.

## Changed contracts
- hands: new tool hands.find; hands.observe takes match; hands.act/commit can fail needs_front.
- New CLI files only: core/cli/commands/sideview.js, core/cli/commands/voice.js (auto-discovered).

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
