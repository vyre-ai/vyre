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
- Perf: with the four modules, perf-check on testbox (load 9.3, over the rule's 8): CPU 0.00%,
  RSS mean 112.5 MB, RSS max 153.2 MB (FAIL vs 150), no timer under 60 s. Baseline run without them
  failed on load (memory.curate timeout). Re-run the baseline when load < 8 to see if the max is ours.
  ci already tracks an idle-RSS regression on main.

## Next
1. Perf baseline (above). If the glue adds real RSS, lazy-load suggest's lists (they already are)
   and sight's table only on first use.
2. Owner replies: record below. Send owners the built contracts and their exact asks.
3. Drift test (item 9): hardcoded model/effort/policy lists and token files.
4. Hand the finished sha to the integrator (no WIP pushes until the lead says "pushes open").

## Agreement tracker
| # | Item | Owners | Status |
|---|---|---|---|
| 1 | One screen service, both sides (sight) | capsule-pro, pwa, mobile, sessions, chat; acting modules; platform (call id) | glue built; owner asks to send |
| 2 | Context now | capsule-pro, chat, pwa, mobile, sessions | glue built; asked |
| 3 | Connections for a capability | vault (owns, ADR 0028 9b), connectors | vault owns; align |
| 4 | Suggest | memory-iq, capsule-pro, chat, native-core | glue built; asked |
| 5 | One ask path + wife's-name fix | memory-iq, sessions, capsule-pro, chat | lead: yes; owners |
| 6 | Commands everywhere | platform, polish-cli, capsule-pro, chat | asked |
| 7 | Keys once through the vault | vault (owns, ADR 0028 9a), connectors, polish-cli | vault owns; align |
| 8 | Waiting on you | pwa, capsule-pro, mobile, polish-cli | glue built; asked |
| 9 | Hub read live everywhere | native-core, platform, app-design, capsule-pro, mobile, sessions | asked |
| 10 | One live catalog | sessions, capsule-pro, chat, mobile | asked |
| 11 | Tips (slot + signals) | docs (content, tips module), app-design (slot spec) | added by lead |

## Needs from others
- platform: tool call id in registry call meta (core/modules/index.js:366) so acted events can carry `call`.
- hands-desktop (modules/hands-desktop/index.js:151): `app` and `call` on desktop.acted.
- hands-chrome (modules/hands-chrome/index.js:68,121,125,147): thread/call on chrome.acted; chrome.open's
  summary carries the full URL with its query into the event store; click fallback stringifies the selector.
- hands-mac (local/hands-mac/hands.js:359, index.js:70): agent/thread/call/summary/why on hands.acted.
- computers: `sight.watch` calls computers.watch as module:sight, so ownSurface (core/computers/index.js:154)
  can't see the real caller; sight keeps agents out, but surface is not checked against the caller.
- switchboard: threads.asks drops `project` in shape() (core/switchboard/asks.js:92); a Bash ask's
  summary isn't redacted (core/switchboard/translate.js:97).
- link: link.pending has no created time (core/link/box.js:94); waiting derives it from the 10 min TTL.
- vault: allow module:suggest (or per surface) on vault.connections.list; a connection event family.
- lead: vault and connectors both plan core/mail (ADR 0028 9c vs ADR 0016 8).

## Changed contracts
- New tools: sight.targets/now/watch/steps, context.report/now, suggest.query/offer/picked,
  waiting.list/count. New events: sight.stepped, context.changed, waiting.changed.
- scripts/lib/docs/check.js OWNERS: + "cohesion".
