# capsule-now

Branch: work/capsule-now · Worktree: ../vyre-capsule-now · Owner session: capsule-now

Fixes from the user's live testing of the Electron Capsule (local/capsule) and vyred. The native
Swift Capsule (work/capsule-pro) carries the same behaviour later: the rules below are written for
them, one per fix.

## Rules for the Swift Capsule

1. **Quick answers read the memory on screen.** When a quick question (Ask Claude) is sent for the
   same words memory just answered, the lines the memory box shows go into the system-prompt append
   under "What the user's own notes say:", one per line, with ages: a fact as
   `<fact> (noted <age> ago)`, a quote as `The user said, <age> ago: "<quote>"` or
   `Claude said, ...`. Then the instruction to answer from them and say when ("a blue Volvo XC40 (you
   said so 2 weeks ago)"). Only what is on screen: the distilled fact and the first three sources.
   Facts under the bar and `more` are not sent. No memory on screen: QUICK_APPEND alone. The prompt
   itself stays the user's words. Reference: `bridge.js` `memoItems`, `memoLines`, `quickAppend`.
2. **Quotes are quotes.** A `recall.search` hit is drawn as `You said, 2 weeks ago: "..."` (role
   assistant: `Claude said`), with its session as a small link. The distilled fact from
   `memory.relevant`, when there is one, is the first line. Label: "From memory" when there is a
   fact, "From your sessions" when there are only quotes. The page draws `memo` items from the
   bridge; it does not rebuild them.
3. **Notices are status, not answer.** A `thread.text` with `notice: true` never joins the answer
   or a DM message. Keep the newest as `notice` and draw it as one faint mono line under the answer
   (or under the DM list). The switchboard now emits a limit notice only at utilization >= 0.8 or
   status rejected, once per status.
4. **The question is the user's line.** Reply view order: "You" + the question; then a head with
   who answers (e.g. Claude) and the state/cost; then the memory box; then the answer.
5. **A session busy in a terminal gets queued messages.** `threads.send` from a person's surface
   returns `{sent:false, queued:true, thread, name, note}` for a session another process has open.
   Show `note` ("<name> is busy in your terminal. I'll hand it your message when this turn ends.")
   and a status line "Queued for <name>: it gets this when its current turn ends." The reply is the
   thread's as usual: `thread.sent` with `queued` marks it handed over ("handed over"), then
   `thread.text` (done) and `thread.finished` arrive when the answering turn ends. No caret while
   queued. No "Send now (interrupt)": there is no interrupt path into a terminal session.
6. **Open on the Space the user is on, full-screen apps included.** Double-Control over a terminal
   in full screen must open the Capsule over it, never switch to the desktop Space. For the NSPanel:
   style mask `.nonactivatingPanel` set at init (not added later: a mask changed after init is not
   honoured by the window server for key routing); `collectionBehavior` `[.canJoinAllSpaces,
   .fullScreenAuxiliary, .transient]`, set again before every show; level above full-screen windows
   (`.screenSaver`, or `.popUpMenu` if that proves enough); `canBecomeKey` true. Show with
   `orderFrontRegardless()` + `makeKey()`, and never `NSApp.activate`: activation is what switches
   Spaces. Typing must still reach the panel over a normal app too (the Electron build activates the
   app for that today; a true non-activating panel should not need it, so check both by hand).
   Electron reference: `local/capsule/lib/present.js`, flag `VYRE_CAPSULE_STAY=1`.
7. **Quotes are chosen for the question.** Before showing `recall.search` hits (ask for 10, one per
   session): drop the Capsule's own ask threads (name starts "Capsule: ", or cwd under its scratch
   folder), any turn containing the whole question (3+ words) or sharing 80% of its words with
   little else; rank the user's first-person statements that share a word with the question above
   everything, questions and Claude's words below; show at most 2. With no Memory fact, a clear
   first-person sentence from the top hit becomes one line on top, turned to "you" ("You own a blue
   Volvo XC40."), sourced from the quote under it; the label stays "From your sessions", and that
   line is not sent to a model (the quote under it is). No model runs for any of this. Reference:
   `lib/said.js` `rankSaid`, `yourAnswer`.

## Done
- f5bd7b9 fix(switchboard): limit notice only at >= 80% or rejected; `lowlimit` in fake-claude.
- cf4531e fix(capsule): memory in quick prompts, quotes as quotes, notices as status, question line.
- 7524416 feat: queued messages for sessions busy in a terminal (switchboard, harness,
  Capsule, CLI).
- 41aae79 feat(capsule): open over a full-screen app without a Space switch, behind
  `VYRE_CAPSULE_STAY=1`. `present()` in lib/present.js is shared by main.js and the check script;
  unit tests in present.test.js. Default behaviour is unchanged.
- 9c9514a fix(capsule): the memory box ranks for the question (lib/said.js), rule 7.
- 8c888cb feat(threads): `live` on threads.list and projects.catalog rows; threads.unqueue.
- On work/capsule-agent: 3ce1433 the native Capsule calls capsule.report on hotkey state change
  (HotkeyReport, retried on reconnect); a132faf waiting on you is violet #B8A4FF (Theme.attention)
  in the native and Electron Capsules; 7526089 a compile fix for a stray `askItem` line that is
  also on work/capsule-pro's tip.
- Tailnet has my answers to its Mac-send design (sent 2026-09-27).

## Doing
- Nothing in flight. Saved 2026-09-27 at logout.
- The native agent half (the 10 retire blockers in capsule-parity.md) is done on work/capsule-agent,
  head 74b2f6e, and capsule-pro has merged it into work/capsule-pro (fcfcef0). See
  docs/work/capsule-agent.md on that branch.

## Next (open requests, in order)
- Wire threads.unqueue into the Capsules: Esc on a queued reply (native and Electron) and the
  phone. Streaming a queued session's reply live.
- tailnet (answers sent 2026-09-27): sending to Mac sessions from the box. My answers:
  1 yes: a separate WRITE allowlist (threads.send, later threads.unqueue), person callers only, and
    `as: "person"` checked on the Mac.
  2 yes, with an explicit caller kind "link" in guard() and surfaceOf() instead of relying on the
    `/^(mcp|harness)/` regex. The queued note names the Mac ("<name> is busy in your terminal on
    alex-mac. ...").
  3 Events: thread.queued, thread.sent{queued, via}, thread.text (done), thread.finished. For a
    queued message the stop signal is the thread.finished that follows its thread.sent{queued}, not
    the first thread.finished (which may be the turn it interrupted). Keep the 30-minute cap.
  4 Always queue when anything on the Mac holds the lease; never take it from the Capsule.
  Misses: the Stop hook hand-over (harness.stop -> threads.inbox / threads.replied) runs on the Mac
  unchanged; an idle terminal session only gets the words on its next prompt (no nudge).
  threads.unqueue now exists (below); the link WRITE allowlist is tailnet's to extend.
- Watched-thread reports on the empty native Capsule (Electron listed up to 4).

## Standing rule (user, 2026-09-27)
- Vyre does not nag: the user runs on bypass permissions. No prompts and no Touch ID for the
  person's own actions. Touch ID only for pairing a new device, vault secrets, and sending, posting
  or paying outside; one Touch ID lasts about 30 minutes per device.

## Needs from others
- capsule-pro: rules 1 to 7 are carried by the native Capsule (merged). A popover row for
  "Waiting on you · N".
- lead: the trust decision on presence from the box (tailnet item 5).
- switchboard: the threads_inbox migration was appended to MIGRATIONS; order it at merge if needed.

## Changed contracts
- `threads.list` rows and `projects.catalog` sessions gain `live` (boolean). New internal tool
  `threads.live {}` -> `{sessions}`.
- New tool `threads.unqueue {thread, queued?, surface?}` -> `{unqueued: [ids], note?}`, person
  callers only (queuesFor). New event `thread.unqueued {queued, surface}`. `threads.send`'s queued
  result gains `queued_id`.
- `threads.send`: new result `{sent:false, queued:true, open_elsewhere:true, thread, name, note}`
  for a person's caller when the session is open elsewhere. Callers `mcp*` and `harness*` still get
  the old refusal.
- New internal tools `threads.inbox {session, via}` -> `{messages}` and
  `threads.replied {session, text}` -> `{replied}`. New event `thread.queued {queued, text, surface}`.
  `thread.sent` gains `queued` and `via` when the Harness hands words over.
- `harness.stop` may now return `{decision:"block", reason:"Message from the user via ..."}` for
  queued words; `harness.enrich` may prepend them to its text.
- `thread.text` notices: switchboard `limit()` emits only at utilization >= 0.8 or rejected
  (`LIMIT_NOTICE_AT`).
- Capsule snapshot: `reply.notice`, `reply.queued`, `reply.memory.memo`, `dm.notice`; recall
  results carry `memo` and each source `kind` ("fact" or "quote") and `role`.

## Tests
- 2026-09-27 on the test box: switchboard, projects, federation-reads, link-federation, harness
  77/77; switchboard-cli, capsule bridge, onboard, deck machine, guests 70/70.
- local/capsule/lib/bridge.test.js 29/29, state.test.js 14/14, core/switchboard 26/26,
  core/harness 19/19, test/harness.test.js 13/13, core/cli switchboard-cli 11/11, present 3/3.
- Memory ranking (on the test box): bridge 31/31, said 4/4, state 14/14, present 3/3, hygiene 1/1.
- Perf: nothing added polls or runs while hidden (the queue is read only inside hooks that already
  run). perf-check was not run: it measures a running Capsule and the user's is live.
