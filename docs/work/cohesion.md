# cohesion

Branch: work/cohesion · Worktree: ../vyre-cohesion · Started 2026-09-27 from main 7880dfa6 · ADR 0036

## Scope
Make Vyre feel like ONE system: audit every module and surface for interconnection opportunities,
then coordinate the owning teams to wire them through the registry. Cohesion writes contracts,
glue modules (sight, context, suggest, waiting) and drift tests. It does not build features that
belong to another team. Map: docs/design/cohesion.md (19 ranked items, approved by the lead).

## Done
- Survey of every module, surface and team work doc; opportunity map; top 10 agreed with the lead.
- ADR 0036 "One system" (nav + README registered).
- Glue modules built with fakes and tests: core/sight (11 tests), core/context (9), core/waiting (6),
  core/suggest (12). Targeted run on testbox: 123/123 incl. modules and docs tests.
  The fourth module is `waiting`, not `needs`: `needs` is a manifest verb and collided in docs-check.
- docs-check OWNERS gains "cohesion" (scripts/lib/docs/check.js, docs team's file).

## Doing
- rc.2 fixes, both from "Needs from others" below: f3977466 then 4b9c0c0d (branch merged current
  main first, fb9a478e). #7 sight.watch and sight.frame now check their own real caller
  (agentCaller) before forwarding to computers.watch / hands-desktop.screenshot, which only ever
  see "module:sight" once sight forwards; fails closed if agents.list cannot be reached. e2e review
  of the first sha found sight.frame had the same gap (hands-desktop's resolveAgent restricts only
  "mcp:agent:<name>", not a surface-prefixed claim like "cli:agent:<name>"), fixed and tested in
  4b9c0c0d. #3 link.pending carries `created` (core/link/box.js); waiting's fromPending uses it
  directly, falls back to the old expiry-minus-TTL guess for an older box. testbox: 281/281 then
  112/112 targeted (sight, waiting, link*, docs-*, boundaries), nice 15, load under 5 both times.
  e2e signed off 4b9c0c0d (sight 15/15 on testbox); sight.now/targets/steps left unguarded is fine,
  they read state and never proxy pixels. Handed to the integrator. No testbox processes of mine
  running. Items 8, 9, 10 deferred to 0.1.1 per the lead.
- Glass job from the lead: gave glass cohesion's view on sight/waiting/context for item 1, confirmed
  sight.frame is the right call for their reconnect-fallback still and resting-tile preview (no
  separate JPEG path needed), agreed their capture(glass/sight)/render(chat/sessions) split for
  inline chat images. Lead decided the owner call: item 18 added to docs/design/cohesion.md
  (baf5ec7c), chat owns render, sessions passes image blocks through, cohesion keeps sight.frame/
  sight.stepped, glass is a second sight.frame caller not a second capture path. Open for 0.1.1:
  where an agent-made (non-screen) image lives, inline size before it is a link, rate limiting
  sight.frame across two callers.
- New cross-team spec from the lead: item 19 written into docs/design/cohesion.md (f6cc51b0), file
  router + attach-a-session-to-a-project-later + Vyre Drive UI credit. Owners: projects and files
  (router + layout), projects and memory-iq (the attach, shaped like projects.move, and the graph
  join), federation (Vyre Drive credit on the moved-file event). Chat's upload/attach UI spec'd for
  hand-over, chat is paused. Sent the lead a summary; not built, direction and owners only. Lead
  decided attach is person-only (09ac1d0f): a preview, then one confirm, no Touch ID; an agent may
  suggest attaching, never call the tool. Cohesion's part on item 19 is done; needs federation and
  memory-iq to settle the router's exact contract and the graph mechanics next.
- Interaction and cohesion pass over every 0.1.1 plan (capsule-pro, vault, glass, memory-iq,
  teammates, federation, windows, sessions/chat), from the lead, worked with app-design.
  docs/design/interaction.md (93cf1e8d): one interaction language, citing DIRECTION.md and
  system/components rather than duplicating; top 3 upgrades per team; five cross-team seams, each
  with one fix. Sent the lead a summary under 35 lines, not messaging owning teams yet per the
  lead's instruction.
- SAVED for restart. Integrator has 0f4d1105 (release candidate; supersedes f5cd36f7): glue modules,
  drift test, hands privacy fix (e2e signed off), sight.frame, context view/now {surface}, Mac asks,
  suggest account ranking, Chrome teardown fix. testbox: 156 targeted pass; hands-chrome 8/8 on
  CHROME_BIN=/usr/local/bin/vyre-chrome. No testbox processes of mine running.
- Waiting on: integrator landing 0f4d1105; platform P1 382a8574 + settled Render (then tell chat item 5);
  vault 9b 6cf9a99f + default/last_used follow-up; memory-iq memory.suggest + recall prefix;
  capsule-pro screen chip + context.report; sessions thread.status + meta.call header; lead routing
  event renames (glass, harness, computers, projects).
- Owners' built work: pwa work/pwa b623ddcc, 41f9b14d, 084036c1, ca934d2d; chat work/chat 4793f351,
  ccb8b410; native-core work/native-core-composer c012c13c; docs work/docs 393b7c97; app-design specs
  work/app-design b756d128, e00280ad.

## One-system audit refresh (2026-09-28, resume 9)

Re-audited against today's changes: projects.access (federation, 63af8941), chat's sight.frame
stills (18980d2d), personguard (cleared 002e6577, not yet landed), Drive (files/drive.js), the
assistant's linked-projects rule (design-only), the chat/native-core/pwa split. Research-only pass
(fork), no code read as broken enough to warrant a glue sha yet — each finding needs an owner
answer first. Top 5, sent to owners:

1. **projects.access may be a 5th project-identity shape.** core/projects/projects.js's grant/
   check/revoke don't visibly import lib/project-id.js's isProjectId/SLUG_RE (the canonical shape
   landed the same day, different worktree). Sent to federation; offered to take the import+
   validate as pure glue if they'd rather not.
2. **Drive predates today's per-folder-via-projects.access decision.** core/files/drive.js (Taildrive/
   WebDAV Mac shares) gates by Tailscale node attributes only, no projects.access reference at all.
   Sent to federation: confirm whether drive.js is the target of that decision or a separate
   not-yet-built picker is.
3. **personguard vs vault's own presence() — RESOLVED, not a seam.** Reviewer confirmed (checked
   at 002e6577): vault's presence() only builds the tool's declaration/summary text, never checks
   anything itself. The single verifier is core/presence via the registry; the ancestry check
   (daemon/index.js fromClaude) runs whenever `personal` is true (personOnly OR presence.required),
   independent of PERSON_ONLY/OPT_OUT membership. So OPT_OUT can't remove a presence-gated tool's
   proof — the two layers can't drift. Reviewer is adding a line to the landing commit or
   personOnly()'s doc comment saying so.
4. **Three separate state mechanisms — SHIPPED by sessions at 6e2f8a71 (work/sessions).** Turned
   out worse than a naming mismatch: internal "waiting" only ever means an ask is open (a person
   would call that "asking"), internal "idle" is what a person calls "waiting" — a real swap bug,
   duplicated in switchboard's STATE map, the CLI, and chat's own client-side STATUS map. Fixed at
   the source: new pure `lib/thread-status.js`, canonical set starting/working/asking/waiting/
   stopped/finished/failed; switchboard emits `thread.status {status}` alongside the unchanged
   legacy `thread.state`; threads.get/list gain `canonical_status` next to raw `status`. Nothing
   existing changes shape. core/harness's raw-string LIVE check is correct as-is (checks "is the
   process alive," not a person-facing label) but duplicates the array as a literal — sessions
   will add `LIVE_STATUSES` to the lib; cohesion takes the one-line harness import as pure glue
   once it lands (routes to reviewer-2). Relayed chat's own STATUS-map cleanup directly to chat.
5. **The assistant's "sees all linked projects" rule bypasses projects.access — RESOLVED.** memory-iq
   added a one-line comment at core/memory/index.js's {all:true} branch (b4377004, work/memory-iq):
   deliberately independent of projects.access; a future restriction is a rule change there, not a
   projects.access row. Comment-only, no behavior change.

Chat-cohesion pass (item 3, same session): Deck chat and pwa share the same deck/chat/session.js
(monorepo — pwa's own work/pwa branch (waiting/context/sight-pills) hasn't merged to main yet, so
main's chat/pwa are currently IN SYNC by virtue of being unbuilt-ahead, not by design). Capsule
(core/harness/index.js) reads switchboard's raw thread.status field directly today. CLI reads
switchboard's STATE-mapped values through the normal tool path. Once thread.status ships, Capsule's
direct raw-field read needs to move onto it too or it'll show "working" where chat shows "running"
for the same thread — flagged to sessions above, not yet its own separate message since it's the
same root cause.

## Next
2. Owner replies: record below. Send owners the built contracts and their exact asks.
3. Drift test: models + policy rules done (test/cohesion-drift.test.js); add tokens once the hub generates them.
4. Hand the finished sha to the integrator (no WIP pushes until the lead says "pushes open").

## Agreement tracker
app-design specs for every item: work/app-design b756d128, docs/design/system/components/ (suggestions, account-row, needs-row waiting section, credential-sheet, result-card, tip, glass-mini; ask/plan/question cards built once in chat-core).

| # | Item | Owners | Status |
|---|---|---|---|
| 1 | Screen service, both sides (sight) | capsule-pro, pwa, mobile, sessions, chat, platform | capsule-pro yes (sees-chip + context.report this session); mobile yes after 0.1.0 (wants a phone spec; sight.frame offered); sessions yes (passes tool_use id once meta.call exists); platform yes (meta.call from X-Vyre-Call-Id, P1); acted fields done c362505b; sight.frame 791bd180 for the phone; pwa BUILT on work/pwa (waiting b623ddcc, context 41f9b14d, sight pills 084036c1, Glass mini still + device ca934d2d; tests pending); stills refresh on sight.stepped, not a 2 s timer (glass-mini.md fixed, work/app-design e00280ad) |
| 2 | Context now | capsule-pro, chat, sessions, mobile, docs | all yes; chat reports on thread open (4793f351; merged context.now for new sessions ccb8b410); pwa 41f9b14d |
| 3 | Connections | vault (owns), connectors | agreed: vault.connections.list {surface}, vault.connection-added/removed/changed, use {tool, input:{account}} |
| 4 | Suggest | memory-iq (memory.suggest, recall prefix), native-core (composer), capsule-pro | memory-iq yes; capsule-pro yes (local rows first); native-core DONE: deck/chat/core/suggest.js (DOM-free, app can use it), @ mentions + Tab completion + suggest.picked (work/native-core-composer c012c13c); models from sessions.models.get aliases, drift ALLOWED drops composer-state.js |
| 5 | One ask path | memory-iq, sessions, capsule-pro | sessions mostly done 51eaa964 (no temperature in SDK); memory-iq: Said.swift must be REMOVED; capsule-pro removes it once iq.ask + suggest on main (asked for memory.answer fallback now) |
| 6 | Commands everywhere | polish-cli, platform, capsule-pro, chat | polish-cli `vyre <cmd> --view` frames; platform commands.list (382a8574) + Render {kind: 7 kinds} (b7bbf5d8); polish-cli checking per-kind fields |
| 7 | Keys once | vault, connectors, polish-cli, capsule-pro | shape final: needs_credential {module, need, account?} -> vault.need / vault.connect; polish-cli `vyre key` |
| 8 | Waiting on you | pwa, capsule-pro, mobile, polish-cli | all yes; pwa swaps js/needs.js merge, push resolves by row id; Mac asks carry machine 3610f31a (threads.answer {machine} not on main) |
| 9 | Hub read live | native-core, platform, sessions, mobile | native-core yes (rev + non-secret level value); mobile wants per-tool policy flags on /v1/tools |
| 10 | One live catalog | sessions, chat, capsule-pro, mobile | sessions adds thread.status; chat nav refreshes on thread.status + agents.changed (work/chat 4793f351) |
| 11 | Tips | docs, app-design | wired on work/docs 393b7c97 (context.now {surface}.view, waiting.count); pwa to report surface glass from the Glass page |
| 12 | Memory learns | memory-iq, connectors, sessions | memory-iq yes under source trust; reads vault connection events |

## Needs from others
- platform (accepted, P1): meta.call from X-Vyre-Call-Id; registry.status() use counts {calls, lastUsed}; commands.list; events.catalog.
- DONE by cohesion (lead's call, owners stopped): acted-event fields and the chrome query strip, c362505b.
- vault: core 9b 6cf9a99f (awaiting testbox); default + last_used in a small FOLLOW-UP sha (setting a default is person-only, no Touch ID): default_for via vault.connections.update, is_default with a capability filter, last_used (stamped on allowed, 1/min), list sorted default > last_used > label. suggest: rank accounts in that order (already list order).
- mobile: per-tool policy flags (human_only, sessionable) on /v1/tools rows (platform or presence).
- mobile: wants sight.frame (a still JPEG per step) for the relay? Needs a resize in computerd.
- DONE by cohesion (rc.2, f3977466): sight.watch checks its own real caller before forwarding to
  computers.watch, which only ever saw "module:sight"; ownSurface's own note now points at it.
- switchboard: threads.asks drops `project` in shape() (core/switchboard/asks.js:92); a Bash ask's
  summary isn't redacted (core/switchboard/translate.js:97).
- DONE by cohesion (rc.2, f3977466): link.pending carries a real `created` time; waiting's
  fromPending uses it, falling back to the old TTL guess only for an older box.
- vault: allow module:suggest (or per surface) on vault.connections.list; a connection event family.
- DECIDED (lead): connectors owns core/mail; the argument is `account` = the vault connection id.

- lead: route event renames (platform recorded as PLANNED in core/event-catalog): glass + harness file.* -> files.*, computers computer.* -> computers.*, projects projects.moved -> project.moved. Aliases go live one release after each rename.

## One-product audit: findings tracked to done

The lead approved and assigned owners. Tracking each:
- **1 (vault, grants per-agent not per-project) and 5 (no session-credentials design doc, also to
  sessions):** sent to vault and sessions. Vault is already writing session-credentials.md per the
  lead. Status: sent, not yet confirmed.
- **2 (watchers field/UI) and 4 (one canonical project id):** sent to sessions (projects owner).
  Status: sent, not yet confirmed.
- **3 (one shared agent-caller parser):** built, cohesion's own to do since it's glue. Done:
  5ef364c3, `agentClaim` in core/modules, migrated computers/hands-desktop/sight/network/relay/
  planner (6 files); found and closed two real gaps while doing it (computers.resolve/list and
  hands-desktop.resolveAgent only matched the narrower "mcp:agent:" shape). testbox: 340/340. Left
  core/daemon/index.js's own copy alone - e2e's work/e2e-agentclaim (1ff45c03) touches that same
  file and I didn't want to risk a conflict with work still landing; flagged for e2e/integrator to
  fold in after. e2e review found a MEDIUM: agentClaim returned "" for an empty/odd name ("cli
  agent:"), which every caller's `if (claim)` read as no claim at all - trusted fully instead of
  refused, since the daemon's socket vouch (which does catch this) never runs for an in-process
  caller. Lead: this makes it an rc.2 candidate (real holes closed), not 0.1.1; fix now, base on
  pre/rc if clean. Fixed in 1a8bf671: returns "(unnamed)" instead, fails closed everywhere. New
  tests for "cli agent:kit"/"mcp agent:kit" (space form) and the empty-name case in both
  modules.test.js and guests.test.js. testbox 340/340 again. pre/rc (60fdcd07) doesn't have my
  agentClaim work yet, only a tracking note in integrator.md - handing the sha to e2e and the
  integrator to fold in, not rebasing myself since pre/rc has independently diverged on some of
  the same files (core/modules' credential validation). Sent to e2e and the integrator.
- **6 (chat's project-picker UI, first end-to-end check on restart):** added to the paused-teams
  hand-over note below.

## One-product audit (projects x sessions x IQ x watchers x teammates x helpers x chat x vault)

Merged main into work/cohesion first (58007a54; rc.1 landed since my last merge, resolved
CHANGELOG.md/waiting.test.js/generated-docs conflicts by hand, targeted tests 90/90, boundaries
5/5 clean). Worked from sessions' docs/design/projects-map.md (their factual map) plus the code.
Sent the lead 6 ranked findings, under 25 lines, not yet messaging owners: vault grants are
per-agent not per-project (a shared teammate could use the wrong client's creds); watchers have no
marker field or UI at all; agent-caller identity is checked by separate per-module regexes (the
exact class of bug I patched twice this week in core/sight); project identity has four unrelated
shapes (marker+slug, memory's folder-path list, a teammate's agent-name suffix, a coming grants
column); no session-credentials design doc exists; chat's project picker is data-ready but its UI
is paused/unconfirmed. Waiting on the lead before messaging vault/projects/sessions/chat.

## Follow-ups from the interaction pass

- Item 20 (696107fb): the lead decided the Chrome extension ships 0.1.1; cohesion's part is one
  login experience with the Capsule (one vault, one grants model, one waiting.list row, one
  account-row look). Sent to vault (owns the vault side) and capsule-pro (fill UI is the reference
  look). glass folded items 1-3 into glass-plan.md (76411504); asked about a continuous-latency
  ping primitive - answered (relay/channel.js's frame ping for the relayed path reused; direct path
  needs a small new ping on Glass's own stream, nothing existing to reuse there). windows folded
  its 3 into windows-plan.md and ADR 0037 (f2c5ef02); flagged interaction.md is plain-text-linked
  on their branch since it's not on main yet - fine, convert once both merge. memory-iq set the
  stream cutover: 30 Sep 2026, integrator's first 0.1.1 batch, memory-iq's sha and the Capsule land
  together (work/memory-iq ffae4f08, "The stream cutover"). app-design wrote the Answer card into
  result-card.md (00d3f471); grep swept `--beacon-wash`/`--recall-wash` before RC close per their
  ask - site/styles.css on origin/main (a3a844e4) still has both at .held-chip/.block.beacon-bg,
  their fix 57eebd9f sits on refs/remotes/e2elabel/pre/rc, not origin/main; flagged back to them,
  not yet resolved either way.

## Hand-over: paused teams (sessions, chat, pwa, mobile)

Interaction pass (docs/design/interaction.md, sha 5debc1bc), 2026-09-28. These four are paused;
the lead delivers this when each restarts after rc.2, so it's collected here rather than sent now.

- **sessions.** Ship `thread.status` (chat is already listening for it - the missing wire is on
  your side). Be ready for `memory.ask {stream:true}` to become the default everywhere in 0.1.1
  once memory-iq sets the cutover date - don't build an interim streaming path.
- **chat.** Item 18 (inline images: `sight.frame` stills at a step, and agent-made images, owner
  split already decided) is your highest-visibility 0.1.1 item. Nav should refresh live on
  `thread.status` once sessions emits it. The Answer card (app-design's confirmed shape, section 6
  of interaction.md: no header, plain never-colour-coded confidence line, source chips, quiet
  inline "Wrong?", untimed Undo after a correction) is what memory-iq's card should render as, once
  you cut over to `memory.ask`. **One-product audit finding 6 (lead-assigned):** the project picker
  (`context.now`-started sessions) is data-ready but the UI is unconfirmed shipped, per sessions'
  projects-map.md - make this the first thing verified end-to-end on restart, before anything else,
  since a person's `@design` landing in the wrong project silently is the kind of seam this whole
  pass exists to catch.
- **pwa.** Everything under cohesion items 1, 2, 8 and 11 that already lists pwa as an owner
  (sight/context/waiting/tips) should read app-design's shared card-and-row state vocabulary
  (interaction.md section 0: hover/pressed/focus/selected/swiping/committed, the seven list states
  in states.md) rather than a PWA-specific version of any of them. **Finding 6** applies to pwa's
  own project picker too, same as chat's.
- **mobile.** Same vocabulary as pwa, plus: the swipe rule's exact numbers now have a citation
  (interaction.md section 3: 100pt full reveal or 0.5px/ms fling past 24pt commits, presence-gated
  primaries show the biometric glyph in the reveal itself). Sight.frame stills (item 18) apply to
  mobile's chat surface the same as chat's.

## Changed contracts
- New tools: sight.targets/now/watch/steps, context.report/now, suggest.query/offer/picked,
  waiting.list/count. New events: sight.stepped, context.changed, waiting.changed.
- scripts/lib/docs/check.js OWNERS: + "cohesion".

## Resume 9, second pass: the two glue jobs the lead assigned

- **State-mapping glue (Capsule/CLI/harness):** blocked — `thread.status` is still on sessions'
  Next list, not shipped. Confirmed the real drift while there: `core/switchboard/index.js:207`'s
  STATE map relabels `working` as `running`, but `core/harness/index.js` reads the raw
  pre-mapped value directly (line ~142) — two readers already disagree before Capsule/CLI even
  enter it. Sent to sessions asking for the shape/ETA; will build the shared lib the moment it's
  settled.
- **projects.access vs lib/project-id.js:** validated. `projects.access.check` already uses
  `isProjectId` correctly. Found one real duplicate: `core/projects/markers.js`'s `slugify` is a
  byte-identical copy of `lib/project-id.js`'s, not an import — exactly the drift the lib's own
  comment warns about (it claims markers.js already re-exports it; it doesn't). Verified the fix
  (import + re-export) in federation's own worktree: 37/37 + 15/15 local, 42/42 on testbox. Did
  NOT commit it — that's federation's branch/file and they're actively on it (per RULES, I don't
  commit outside my own worktree). Sent them the exact diff and test evidence to land themselves.

## State-mapping glue, built in my own tree (ee19e955)

Wrote `lib/session-state.js` (+ test) against switchboard's current STATE map rather than waiting
idle on sessions: `canonicalOf({status, hasOpenAsk, hasQueued})` folds the raw status plus the two
facts no single status field carries into the four words `queued/asking/waiting/stopped`. Ready to
switch its caller's input to `thread.status` the moment sessions ships it — the fold itself
shouldn't need to change. testbox: 12/12 (session-state + boundaries), docs:ref clean, docs-*
61/61. NOT yet wired into Capsule/CLI/harness — that's the next step, and needs each of those
three's own read of a thread's status/ask/queued state identified first (their side, once I have
their go-ahead to touch capsule-pro's Swift and the CLI). Sent to reviewer-2.

## CLI glue, built (64b55255)

sessions confirmed lib/thread-status.js's final shape (28a8b4f8: an 8th state, "paused" -- an
idle timeout/restart/rewind, resumable, not an error; plain "stopped" is now specifically the
person pressing Stop; "failed" now also covers a real crash). Pulled the lib + its test up to that
shape. core/cli/commands/threads.js: added statusWord(t) (threadStatus() + stopped_reason) and
swapped every place it printed switchboard's raw status word to a person (threadTable, threadCard,
both live-view header lines, row()'s status column) onto it. stateOf (the --view card state) now
keys off the canonical word via a CARD_STATE map instead of the raw one; row()'s beacon now also
flags a failed thread. Every raw-status comparison used for logic/styling stayed untouched -- those
already meant the right thing internally, only the printed word was wrong. Capsule's Swift side
doesn't read raw thread status this way at all (its own gate/ask/lesson model) -- no fix needed
there. testbox: 56/56 targeted, docs:ref clean, full core/cli 340/340. Sent to reviewer-2.

Collision note: this worktree briefly had two live cohesion sessions (a fork of mine, relaunched
independently off the same resume-9 prompt) -- it landed 48d70ed1 (harness onto LIVE_STATUSES)
concurrently with my own work; no data lost, but from here on: `git log --oneline -3` before every
commit, and no editing another team's own worktree even to test-and-revert (team-lead's
correction) -- use my own tree or a `git archive` export instead.

## reviewer-2 signed off 64b55255

One non-blocking DRY nit: statusWord(t) recomputes threadStatus() from raw fields instead of
reading threads.get/list's precomputed canonical_status. Checked before applying it: canonical_
status isn't in this tree yet (6e2f8a71's switchboard change is still on sessions' own branch;
only the standalone lib got cherry-picked in at 48d70ed1). Deferred on purpose -- swap
statusWord(t) to `t.canonical_status` once that switchboard sha reaches this branch, same small-
sha style. Not done yet.

## New job from the lead: one shared reach() for memory/recall/files

Read all three existing copies before writing anything:
- core/recall/index.js's reach() (memory-iq) is the most correct and closest to the lead's spec
  already: unnamed callers refused by default (not admitted), assistant unchecked against
  projects.access (being the assistant is the exemption) but SCOPED to mapped projects for raw
  content, a named/wildcard agent intersected with projects.access per project, ownerDevice
  (core/modules, the kernel's own relay-paired/tailnet-verified-owner check) used correctly.
- core/memory/index.js's reach() is the stale copy: never intersects agents.projects with
  projects.access at all (a named agent's own agents.list grant is trusted outright, the exact
  "guests let in" class of bug), uses a local viaTailnet regex instead of the kernel's ownerDevice,
  and gives the assistant unconditional all:true (no mapped-projects distinction) -- arguably by
  design for facts, but not distinguished from project content at all today.
- core/files/access.js (federation) is a plain-function port of memory's OLD logic: an unnamed
  caller gets {all:true} unconditionally, with no owner/module check at all -- the worst copy,
  exactly the "unnamed callers unrestricted" bug the lead named.

Proposed the single door as `projects.reach` (core/projects, federation's module, since it owns
projects.access and the ctx.call fan-out — agents.list, projects.list, projects.access.check per
project — belongs in one place, not three). Takes {agent?, kind: "facts"|"content"}; kind only
matters once an agent is named (the assistant skips projects.access under "facts", is scoped to
every mapped project under "content" per the lead's 2026-09-28 ruling); an unnamed caller's
admission never depends on kind — owner/module/ownerDevice/a model's own session is {all:true},
everything else refused, full stop. Sent the complete tool code to federation, and the specific
bugs plus the migration path (their reach()/personalOnly() call sites) to memory-iq.

NOT landed anywhere: this needs core/projects' own projects.access (not on main yet, so not in
this tree either — same gap markers.js hit) and touches core/memory/core/recall (memory-iq) and
core/files (federation), none of which are my worktrees to commit in. Design + exact code handed
off; waiting on federation to land the tool, then memory-iq and federation to move their own
callers onto it with tests, per the lead's ask.

## Loud manifest-validation failures, built (962f6160)

teammates' bug: a camelCase tool/event name failed validate() and dropped the whole module with
no log line -- found only by inspecting discover()'s problems by hand. Registry.start()
(core/modules/index.js) now logs `warn: module <name> invalid: <reason>` for all three silent
cases (a bad manifest, a duplicate module name, an order() cycle/missing dependency). Checked
before building #2: status() (vyre modules, GET /v1/modules) already lists invalid/failed modules
with their error text -- that surface already existed, nothing new needed there, just confirmed
with a test. New test feeds a camelCase-tool manifest and asserts the log line + status() entry;
new hygiene test runs discover() over the real core/local/modules trees so a bad shipped manifest
fails CI, not only a by-hand check. testbox: 43/43 (modules, hygiene, boundaries), daemon 19/19.
Sent to reviewer-2 and the integrator.

## Temp-home leaks from vyred-present.js, built (23d1fa1b)

teammates found 16 leaked temp-home dirs after rc.2's canonical run. Found two real, separate
gaps rather than one:
- test/vault-cli-totp.test.js's own vyred() helper had a weaker copy of tempHome's kill logic:
  SIGTERM, a bounded wait, then rmSync regardless of whether the process had actually died -- the
  same "deleted a home out from under a still-running vyred" bug tempHome's own stopDaemon was
  already hardened against, just not reused here. Exported stopDaemon and moved this caller onto
  it.
- stopDaemon itself didn't confirm death after its own SIGKILL escalation before returning; added
  one more bounded poll, now throws (does not remove the home) on the edge case where even SIGKILL
  hasn't taken effect yet, rather than silently deleting into a still-live process.
- The class of leak an outside kill of the whole test process causes has no in-process fix by
  definition (no hook runs when the process itself is killed). test/tmp-guard.mjs is the one
  mechanism that survives that -- it used to only report + fail the run; it now also reaps what
  it finds (kills any live vyred.pid, removes the dir) so leaks self-heal run over run while still
  failing the run that made them.
New test/tmp-guard.test.js exercises the guard directly with its own nested before/after cycle.
testbox: tmp-guard 2/2, vault-cli-totp 15/15, login-keychain+modules+cli+hygiene 49/49, docs:ref
clean. Sent to reviewer-2 and the integrator.

## journey.test.js:221 CI failure, built (31cf7b38)

Pulled the CI log myself (gh run view 36369891756 --repo vyre-ai/vyre --log-failed) rather than
wait, per the lead's correction: this fails EVERY push on main's CI (c3a69611), both node 22 and
24 jobs, and passes every time on testbox -- deterministic and environment-specific, not a flake.
Compared the exact failure symbol-for-symbol across three runs (CI node22, CI node24, testbox
node22): the JSON the subtest checks (box:null, no peer named) is byte-identical in all three --
not a race, nothing about mock ordering or DNS differs. What differs is whether Node's own test
runner honors `{todo}` for a doubly-nested subtest (test -> t.test -> t.test) whose assertion
fails: CI's node22 doesn't honor it at all (plain failure); CI's node24 marks it todo but still
counts it in the fail total; testbox's node22 build honors it fully. Three behaviors, same input,
none of them a real product bug.

Fix: replaced the throwing assert.match with a manual check reported via t.diagnostic(), which
cannot fail a test on any Node version regardless of how todo is implemented there. Kept the todo
option/description so a person still sees the gap, and the diagnostic line names which way it
went, so the day up.js's mac() actually names the peer, that line says so and is the one to turn
back into a real assertion. testbox: journey.test.js 7/9 pass, 1 pre-existing unrelated skip, 1
todo clean with its diagnostic, 0 fail; boundaries 5/5. Sent to reviewer-2 and the integrator.

## settings.test.js hang, built (fcce3d4a)

teammates found core/settings/settings.test.js hanging (0% CPU) on work/teammates 38c64017.
Confirmed it does not reproduce on main (settings.js/settings.test.js are byte-identical there --
diffed via git archive of their commit into a scratch dir, never touched their worktree). Root
cause was at the kernel level, not settings: core/modules/index.js's Registry.stop() awaited each
module's own stop() with no bound at all, so any one module's stuck stop() (an open handle, an
unresolved promise) hangs every caller of stop() forever -- settings.test.js just happens to start
a full in-process vyred in 16 of its own tests, exposing it to any such bug anywhere in a default
box role's module set.

Fix: races each module's stop() against MODULE_STOP_MS (5s, matching daemon's own DRAIN_MS),
logs loudly and moves on. New regression test uses node:test's mock timers (t.mock.timers.tick) to
prove it deterministically and fast -- a real multi-second wait would either leave a dangling
promise past the test (node:test's own pending-promise-at-exit check flags this, learned the hard
way) or genuinely cost the real MODULE_STOP_MS every run. Also added { timeout: 30_000 } to all 16
settings.test.js tests that start a real daemon, so a hang anywhere else in this path fails loudly
under a minute rather than tying up CI forever. testbox: modules+settings+boundaries+hygiene
70/70, docs:ref clean. Sent to reviewer-2 and the integrator.

## lib/caller.js — the one isPerson/isAgent/agentName/isOwnerDevice

Built to stop the recurring bug the reviewer keeps catching (latest: sessions' goals, bb3b9b4e):
"no agent name means the person" admits a bare model session, the harness, a guest and a hook.
Composes core/modules (agentClaim, ownerDevice, callerKind) and core/presence (PERSON_SURFACES),
both kernel, rather than re-deriving their regexes. isPerson checks the agent claim FIRST -- a
caller shaped "cli:agent:kit" reads its own callerKind as "cli" (PERSON_SURFACES would otherwise
wrongly admit it), the same transport-spoofing shape e2e already fixed for agentClaim's other
callers.

Needed personguard in this tree first: cherry-picked b3b7b1dc + 002e6577 from origin/main
(already landed, reviewer-cleared) rather than a full 185-commit main merge -- one CHANGELOG.md
conflict resolved by hand.

Full audit (a forked agent, core/ and local/ only, no edits): two REAL backwards bugs found --
core/mcp/hub.js's whoFrom() strips the agent: suffix before checking PEOPLE.includes(kind), so
"cli:agent:kit" reads as person AND agent at once; core/link/mac.js's kindOf() does the same
split-and-check shape. Everything else found is either a different concept (tool-level personOnly
declarations, labeling) or correct-but-duplicated (core/projects/glass/hooks/files-drive's own
isAgent(), core/harness/rules.js's/core/modules/federate.js's/core/memory/index.js's own
OWNER-equivalent sets -- federate.js's TAILNET_PERSON is narrower than isOwnerDevice, missing the
relay-paired device: case). Sent the two real bugs and every correct-duplicate's exact line to
the lead and to federation/memory-iq. Did not touch any other team's file.

New hygiene test freezes today's known hand-rolled PERSON_SURFACES copies (allowlist only
shrinks, boundaries.test.js's convention) -- a Set of exactly cli/local/deck/capsule outside
lib/caller.js or core/presence/index.js. testbox: caller 8/8, hygiene 5/5, boundaries 5/5,
docs:ref clean. Sent the helper to the reviewer.

isPerson later hardened once more (e2e2, reviewer-cleared 040e52fd): callerKind strips "thread:"
same as "agent:" (ADR 0030), so "cli:thread:x"/"deck:thread:x" used to read as a plain person
surface. Refuses any thread: label directly now (a local THREAD_CLAIM regex, not core/modules'
agentClaim -- a thread claim isn't an agent claim). Both real audit bugs are fixed and reviewer-
relayed: e2e2's core/link/mac.js kindOf() at 9138e567 (cleared); federation's core/mcp/hub.js
whoFrom() -- first pass 513f984d held by the reviewer (its named regex missed the space-separated
and empty-name claim shapes lib/caller.js's AGENT_CLAIM already handles; reviewer sent federation
the one-line fix). sessions and federation both sit on branches whose merge-base predates
personguard/PERSON_SURFACES landing on main, so neither could import lib/caller.js directly yet;
both wrote the equivalent check locally with a swap-to-lib/caller.js note for their next main/
stage merge -- flagged to the lead as a stage/0.1.1-fold cleanup item.

## docs-check fix on stage/0.1.1 (work/cohesion-docs, separate worktree)

Quick job from the lead: stage/0.1.1's docs-check failed on docs/design/teammates.md (owner
"teammates" isn't a known team, status had a parenthetical instead of one word, missing from
nav.json, 21 em dashes, 3 stale tool mentions). Fixed at 1e57575a on work/cohesion-docs (own
worktree ../vyre-cohesion-docs, off stage/0.1.1): owner -> chat, status -> draft (granular
per-section status moved into prose), added to nav.json, em dashes replaced with colons/commas,
team.projectHasAny/team.autoAdd reworded or terms-ignored (deliberately hypothetical/negative
mentions), team.preset's false "already in ADR 0031" claim removed rather than kept. Regenerated
docs/index.json + docs/reference/index.md (npm run docs:ref). Checked docs/work/projects-map.md
and docs/work/pwa.md too, as asked -- both already clean on stage/0.1.1, no changes needed.
testbox: docs-check+docs-build+docs-index 50/50. Sent the sha to the integrator.

## vyre doctor: a failed module is now a named check, not silent (reviewer finding, from tailnet)

tailnet lost real time to a gotcha (docs/work/tailnet.md, 28 Sep): a module that registers a tool
or emits an event its own module.json doesn't declare fails to start; every other module still
loads, so "no such tool" from something that quietly never registered was the only symptom.
core/modules/index.js's startOne already logs this loudly and by name (`module X failed to
start: <manifest-key sentence>`) and status()/`/v1/modules` already carries the same `error`
forever -- but nothing read it except grepping vyred's log, and `vyre doctor` said nothing at all.

Added a `modules` check to core/cli/commands/doctor.js (core/cli/commands/doctor.js,
core/cli/commands/doctor.test.js): GET /v1/modules on THIS machine (box or Mac, whichever `vyre
doctor` runs on -- a module runs wherever vyred does, this is not a box-only fact like `paired`),
gated on vyred being up. Fails naming the module and vyred's own error sentence when any module is
`failed`/`invalid`, names all of them when more than one is. New tests cover the pass case, the
tailnet-shaped single failure, multiple failures, and the vyred-down gate. Kept in `IDS`/`LABELS`
order so `--view`'s live checks frame and `item()` pick it up for free -- no other file hard-codes
the check list. testbox: doctor 13/13, boundaries+hygiene+modules 58/58 total.

## stage/0.1.1: three test failures fixed (work/cohesion-011, separate worktree)

Blocked the 0.1.1 tag: d9b916d4 (ancestor of stage/0.1.1) already had these three failing, so
they predate today's work. Branched work/cohesion-011 off stage/0.1.1 (own worktree
../vyre-cohesion-011). All three, plus the wider affected suites, are green on testbox.

1. **cohesion-drift**: deck/chat/composer.js's createAndAsk hardcoded `model: "sonnet"` for a
   teammate created on a guess (@role, no existing teammate). Added `guessModel()`: reads
   sessions.models.get's aliases and picks the middle tier itself (never opus, per the existing
   comment's own reasoning), so no model id string lives in the surface.
2. **deck-contract**: `voice.status`/`voice.listen` (local/voice, a Mac-local module) and eight
   `federation.move.*` calls in deck/views/settings.js (Move to a server, 0.1.2 per
   team/BACKLOG-0.1.2.md, no federation module built yet) have nothing to answer on a real box.
   Renamed the test's ELSEWHERE set to OPTIONAL, a tool -> reason map (voice: already
   missing-tool safe; federation.move.*: gated live). Gated settings.js's drawServer on
   modules() naming "federation" before it ever draws the move flow or calls move.plan, so 0.1.2
   turns it on with no revert needed here.
3. **presence-bypass**: threads.answer's Mac-forward presence rule (core/switchboard/index.js's
   gatedOnMac) failed closed on ANY unknown ask with no `machine`, even on a box that has never
   paired a Mac -- the common single-box 0.1.1 case. Traced to the LOW-1 hardening (e2e review of
   0f2a8752): it widened "unknown, named by machine" to "unknown, period," which is broader than
   ADR 0021 section 3a documents and broader than the fix's own motivating case needed (a
   restarted, *paired* box forgetting macAsks). Added a live check of core/link/box.js's
   link_peers table (kind='mac'; reads may join any module's table, core/modules/index.js) so
   gatedOnMac only fails closed on an unnamed unknown ask when a Mac has actually ever paired
   here. test/federation-answer.test.js's own LOW-1 test (a real paired Mac) still passes;
   presence-bypass's standalone box now asks nothing for an unrecognized ask id, matching the
   no-nag rule. Updated ADR 0021 section 3a to say so. Sent to the reviewer: this was a
   regression, not an intended broadening -- the general "answering asks presence" rule stays
   no-proof (ADR 0024), the Mac-forward exception is unchanged, only which boxes it can apply to.
   deck/chat/session.test.js's sessions.models.get fixture was also missing `aliases` (unmasked
   by fix #1 above); added.

testbox: cohesion-drift + deck-contract + presence-bypass + federation-answer + caps +
composer-state + session + settings-server + team, 114/114. docs:ref regenerated (the ADR edit);
docs-build/docs-check/docs-index/docs-shots 61/61 locally.
