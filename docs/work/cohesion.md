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
- Integrator has f5cd36f7 (glue + drift test; targeted 125/125). Perf, load under 6: baseline RSS
  mean 105.1 / max 152.4 MB; with glue 111.0 / 155.3 MB; CPU 0.00%; no timer under 60 s. Lead:
  don't block on RSS (ci moving the gate to heapUsed).
- c362505b (not pushed yet): PRIVACY fix, chrome.acted no longer stores URL queries (scrub());
  thread/call/app on chrome.acted, desktop.acted, hands.acted; context.report fills device from
  device:<id>. testbox: 46 pass, 10 skipped (Chrome e2e: no Chrome on testbox). Waiting on e2e's
  review and a Chrome run (Mac or CI), then hand to the integrator.

## Next
2. Owner replies: record below. Send owners the built contracts and their exact asks.
3. Drift test: models + policy rules done (test/cohesion-drift.test.js); add tokens once the hub generates them.
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
| 8 | Waiting on you | pwa, capsule-pro, mobile, polish-cli | glue built; mobile yes (after 0.1.0) |
| 9 | Hub read live everywhere | native-core, platform, app-design, capsule-pro, mobile, sessions | native-core yes (settings.changed = rev + non-secret level value; lists from settings.schema and presence.policy) |
| 10 | One live catalog | sessions, capsule-pro, chat, mobile | asked |
| 11 | Tips (slot + signals) | docs (tips.next/dismiss/seen/whatsnew/list, teaches.tips), app-design (slot spec) | docs building |

## Needs from others
- platform (accepted, P1): meta.call from X-Vyre-Call-Id; registry.status() use counts {calls, lastUsed}; commands.list; events.catalog.
- DONE by cohesion (lead's call, owners stopped): acted-event fields and the chrome query strip, c362505b.
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
