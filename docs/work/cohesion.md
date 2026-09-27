# cohesion

Branch: work/cohesion · Worktree: ../vyre-cohesion · Started 2026-09-27 from main 7880dfa6 · ADR 0036

## Scope
Make Vyre feel like ONE system: audit every module and surface for interconnection opportunities,
then coordinate the owning teams to wire them through the registry. Cohesion writes contracts,
glue modules (sight, context, suggest, waiting) and drift tests. It does not build features that
belong to another team. Map: docs/design/cohesion.md (17 ranked items, approved by the lead).

## Done
- Survey of every module, surface and team work doc; opportunity map; top 10 agreed with the lead.
- ADR 0036 "One system" (nav + README registered).
- Glue modules built with fakes and tests: core/sight (11 tests), core/context (9), core/waiting (6),
  core/suggest (12). Targeted run on testbox: 123/123 incl. modules and docs tests.
  The fourth module is `waiting`, not `needs`: `needs` is a manifest verb and collided in docs-check.
- docs-check OWNERS gains "cohesion" (scripts/lib/docs/check.js, docs team's file).

## Doing
- rc.2 fixes, both from "Needs from others" below: f3977466 (branch merged current main first,
  fb9a478e). #7 sight.watch now checks its own real caller (agentCaller) before forwarding to
  computers.watch, which only ever sees "module:sight" once sight forwards; fails closed if
  agents.list cannot be reached. #3 link.pending carries `created` (core/link/box.js); waiting's
  fromPending uses it directly, falls back to the old expiry-minus-TTL guess for an older box.
  testbox: 281/281 targeted (sight, waiting, link*, docs-*, boundaries), nice 15, load 4.65 before.
  Sent to e2e for review (#7 is security), then to the integrator. No testbox processes of mine
  running. Items 8, 9, 10 deferred to 0.1.1 per the lead.
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

## Changed contracts
- New tools: sight.targets/now/watch/steps, context.report/now, suggest.query/offer/picked,
  waiting.list/count. New events: sight.stepped, context.changed, waiting.changed.
- scripts/lib/docs/check.js OWNERS: + "cohesion".
