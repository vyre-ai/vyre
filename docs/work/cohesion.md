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
- Handed 3383d308 to the integrator (pushed): on top of f5cd36f7, the hands privacy fix (c362505b,
  a4efd0d8, 533f84e2; e2e signed off), context view + now {surface}, sight.frame, Mac asks answered
  on the Mac, suggest account ranking, Chrome teardown fix. testbox: targeted non-Chrome set 156
  (all pass after the context shape fix), hands-chrome e2e on testbox Chromium 8/8, no Chrome left.
- Owe chat: tell it when platform P1 (382a8574, commands.list) and the settled Render shape are both on main (item 5).
- Next: follow owners as their parts land; switch suggest/waiting to ctx.modules.status() when
  platform 382a8574 is on main.

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
- computers: `sight.watch` calls computers.watch as module:sight, so ownSurface (core/computers/index.js:154)
  can't see the real caller; sight keeps agents out, but surface is not checked against the caller.
- switchboard: threads.asks drops `project` in shape() (core/switchboard/asks.js:92); a Bash ask's
  summary isn't redacted (core/switchboard/translate.js:97).
- link: link.pending has no created time (core/link/box.js:94); waiting derives it from the 10 min TTL.
- vault: allow module:suggest (or per surface) on vault.connections.list; a connection event family.
- DECIDED (lead): connectors owns core/mail; the argument is `account` = the vault connection id.

- lead: route event renames (platform recorded as PLANNED in core/event-catalog): glass + harness file.* -> files.*, computers computer.* -> computers.*, projects projects.moved -> project.moved. Aliases go live one release after each rename.

## Changed contracts
- New tools: sight.targets/now/watch/steps, context.report/now, suggest.query/offer/picked,
  waiting.list/count. New events: sight.stepped, context.changed, waiting.changed.
- scripts/lib/docs/check.js OWNERS: + "cohesion".
