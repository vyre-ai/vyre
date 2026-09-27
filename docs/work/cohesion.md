# cohesion

Branch: work/cohesion · Worktree: ../vyre-cohesion · Started 2026-09-27 from main 7880dfa6

## Scope
Make Vyre feel like ONE system: audit every module and surface for interconnection opportunities,
then coordinate the owning teams to wire them through the registry. Cohesion writes contracts,
glue modules (context, connections, suggest, needs) and drift tests. It does not build features
that belong to another team.

## Done
- Survey of Capsule (work/capsule-pro), Deck/chat/PWA/Expo, vault/connectors, memory/recall/
  sessions, CLI/platform/hub, and every team work doc.
- docs/design/cohesion.md: opportunity map, 15 ranked items, 6 cross-cutting contracts.

## Doing
- Top 10 sent to team-lead (decisions asked: ADR number, restart vault+connectors?, item 4 with the wife-name fix). Owner asks sent to capsule-pro, chat, sessions, memory-iq, platform, polish-cli, native-core, pwa, mobile, app-design; waiting on replies. vault and connectors held until the lead answers.

## Next
1. Owner agreement on items 1-10 (record yes/no/changes per owner below).
2. ADR for the four glue contracts (number from the lead).
3. Build glue modules with fake providers and tests: connections, context, needs, suggest.
4. Drift test: fail when a surface hardcodes models, effort levels, SESSIONABLE/HUMAN_ONLY, tokens.

## Agreement tracker
| # | Item | Owners | Status |
|---|---|---|---|
| 1 | Context now | capsule-pro, sessions, memory-iq, chat | proposed |
| 2 | Connections for a capability | connectors, vault, capsule-pro, pwa | proposed |
| 3 | Suggest | memory-iq, capsule-pro, chat, native-core | proposed |
| 4 | One ask path | memory-iq, sessions, capsule-pro, chat | proposed |
| 5 | Commands everywhere | platform, polish-cli, capsule-pro, chat | proposed |
| 6 | Keys once through the vault | vault, connectors, polish-cli, capsule-pro, pwa | proposed |
| 7 | One waiting-on-you + notice path | pwa, capsule-pro, mobile, polish-cli | proposed |
| 8 | Hub read live everywhere | native-core, platform, app-design, capsule-pro, mobile, sessions | proposed |
| 9 | One live catalog | sessions, capsule-pro, chat, mobile | proposed |
| 10 | Memory learns from everything | memory-iq, connectors, sessions | proposed |

## Needs from others
- lead: ADR number for the glue contracts; whether vault and connectors (stopped/paused) get
  restarted for items 2 and 6.

## Changed contracts
- None yet. Proposed new tools/events are listed in docs/design/cohesion.md.
