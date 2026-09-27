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
- Integrator has f5cd36f7 (glue + drift test; targeted 125/125).
- Unpushed, waiting on e2e re-review of a4efd0d8 and the Chrome e2e on testbox (Playwright Chromium at
  /opt/ms-playwright/chromium-1187/chrome-linux/chrome, CHROME_BIN, one Chrome at a time, after the
  integrator's suite): c362505b + a4efd0d8 (chrome.acted scrub, thread from meta only, call/app on acted
  events), 9accaebe (context view + now {surface}), 791bd180 (sight.frame JPEG still), 84d42bb0 (Mac asks
  answered on the Mac until federation). Unit runs so far: 18 pass / 7 Chrome skips; context, sight, docs
  and waiting runs queued (load gate).
- Then: merge main, full targeted run, docs:ref, push, hand the sha to the integrator.

## Next
2. Owner replies: record below. Send owners the built contracts and their exact asks.
3. Drift test: models + policy rules done (test/cohesion-drift.test.js); add tokens once the hub generates them.
4. Hand the finished sha to the integrator (no WIP pushes until the lead says "pushes open").

## Agreement tracker
app-design specs for every item: work/app-design b756d128, docs/design/system/components/ (suggestions, account-row, needs-row waiting section, credential-sheet, result-card, tip, glass-mini; ask/plan/question cards built once in chat-core).

| # | Item | Owners | Status |
|---|---|---|---|
| 1 | Screen service, both sides (sight) | capsule-pro, pwa, mobile, sessions, chat, platform | capsule-pro yes (sees-chip + context.report this session); mobile yes after 0.1.0 (wants a phone spec; sight.frame offered); sessions yes (passes tool_use id once meta.call exists); platform yes (meta.call from X-Vyre-Call-Id, P1); acted fields done c362505b; sight.frame 791bd180 for the phone; pwa yes (mini-view after Design A) |
| 2 | Context now | capsule-pro, chat, sessions, mobile, docs | all yes; context gains `view` and context.now {surface} for tips |
| 3 | Connections | vault (owns), connectors | agreed: vault.connections.list {surface}, vault.connection-added/removed/changed, use {tool, input:{account}} |
| 4 | Suggest | memory-iq (memory.suggest, recall prefix), native-core (composer), capsule-pro | memory-iq yes; capsule-pro yes (local rows first); chat routed composer to native-core |
| 5 | One ask path | memory-iq, sessions, capsule-pro | sessions mostly done 51eaa964 (no temperature in SDK); memory-iq: Said.swift must be REMOVED; capsule-pro removes it once iq.ask + suggest on main (asked for memory.answer fallback now) |
| 6 | Commands everywhere | polish-cli, platform, capsule-pro, chat | polish-cli `vyre <cmd> --view` frames; platform commands.list + Render in P1 (asked to widen Render to 7 kinds) |
| 7 | Keys once | vault, connectors, polish-cli, capsule-pro | shape final: needs_credential {module, need, account?} -> vault.need / vault.connect; polish-cli `vyre key` |
| 8 | Waiting on you | pwa, capsule-pro, mobile, polish-cli | all yes; pwa swaps js/needs.js merge, push resolves by row id; Mac asks carry machine 3610f31a (threads.answer {machine} not on main) |
| 9 | Hub read live | native-core, platform, sessions, mobile | native-core yes (rev + non-secret level value); mobile wants per-tool policy flags on /v1/tools |
| 10 | One live catalog | sessions, chat, capsule-pro, mobile | sessions adds thread.status; chat yes |
| 11 | Tips | docs, app-design | wired on work/docs 393b7c97 (context.now {surface}.view, waiting.count); pwa to report surface glass from the Glass page |
| 12 | Memory learns | memory-iq, connectors, sessions | memory-iq yes under source trust; reads vault connection events |

## Needs from others
- platform (accepted, P1): meta.call from X-Vyre-Call-Id; registry.status() use counts {calls, lastUsed}; commands.list; events.catalog.
- DONE by cohesion (lead's call, owners stopped): acted-event fields and the chrome query strip, c362505b.
- vault: YES in its 9b sha: default_for via vault.connections.update, is_default with a capability filter, last_used (stamped on allowed, 1/min), list sorted default > last_used > label. suggest: rank accounts in that order (already list order).
- mobile: per-tool policy flags (human_only, sessionable) on /v1/tools rows (platform or presence).
- mobile: wants sight.frame (a still JPEG per step) for the relay? Needs a resize in computerd.
- computers: `sight.watch` calls computers.watch as module:sight, so ownSurface (core/computers/index.js:154)
  can't see the real caller; sight keeps agents out, but surface is not checked against the caller.
- switchboard: threads.asks drops `project` in shape() (core/switchboard/asks.js:92); a Bash ask's
  summary isn't redacted (core/switchboard/translate.js:97).
- link: link.pending has no created time (core/link/box.js:94); waiting derives it from the 10 min TTL.
- vault: allow module:suggest (or per surface) on vault.connections.list; a connection event family.
- DECIDED (lead): connectors owns core/mail; the argument is `account` = the vault connection id.

## Changed contracts
- New tools: sight.targets/now/watch/steps, context.report/now, suggest.query/offer/picked,
  waiting.list/count. New events: sight.stepped, context.changed, waiting.changed.
- scripts/lib/docs/check.js OWNERS: + "cohesion".
