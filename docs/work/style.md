# style

Branch: work/teammates (built alongside teammates, same worktree, same agent) · Decisions:
[ADR 0037](../adr/0037-style.md) · ADR claimed in [README.md](README.md).

Scope: a house writing voice for every Vyre-owned session, main, teammate, subagent and job
alike (the user's ask, 2026-09-28, after teammates shipped `team.project-append`): a
system-prompt block banning em dashes, throat-clearing, sycophancy and other AI writing tells;
a person's own free-text addition; a display-side em-dash normaliser (chat, capsule-pro); an
optional lint (chat).

## Done

- `core/style`: `style.append` (the composed system-prompt text; null when off), `style.patterns`
  (the banned-pattern list as data, for a lint), `style.rules.check` (the 500-character cap on a
  person's free-text addition). `style.enabled`/`style.rules` are ordinary `core/settings`
  declarations (account default, project override, person-only to set) - no new table, reusing
  what `settings.get`/`settings.set` already provide, unlike `team.default` which needed its own
  tools because the ADR wanted them named that way; here the generic mechanism was already the
  right shape.
- `lib/plain-prose.js` (team-lead's call, after the first pass): the pattern list and
  `normalizeProse` moved out of `core/style` into a lib, so the Deck, the Capsule's web views and
  core can import them with no module dependency; `core/style`'s `style.patterns` now imports
  from there instead of holding its own copy. `normalizeProse` handles the paired-dash (aside)
  form as parentheses and a single remaining dash as a comma, skipping fenced and inline code.
- `HOUSE_VOICE` trimmed to 158 words (was 206) and checked, by test, to contain no em dash and
  stay under 200 words; `style.rules` capped at 500 characters via `style.rules.check`
  (`module.json`'s `check.tool`), and the only path that could ever write it is `settings.set`
  (already person-only) since `settings.write` refuses a key that names a `check`.
- The em-dash-leak class of bug (reviewer's LOW on `team.project-append`) is closed from the
  start: `style.append` carries the same `callers` reasoning as `team.project-append` (project
  ownership); `style.patterns` has none, since it returns no project data.
- 24/24 across `core/style/style.test.js`, `lib/plain-prose.test.js` and `test/boundaries.test.js`
  (a lib importing only the kernel and other libs), docs-check clean (ADR in nav.json), docs:ref
  regenerated.

## Doing

Nothing right now; section 1's equivalent (sessions calling `style.append` at session start,
next to `team.project-append`) is the next ask to sessions, same shape as before. Sent to
reviewer (the prompt-injection path) and reviewer-2 (the settings UI) per the lead's ask.

## Next

- `style.append`'s session-start pickup is sessions' (sent, queued behind their own work).
- Hand chat and capsule-pro: `normalizeProse` (`lib/plain-prose.js`, ready to import) for chat,
  the Capsule and notifications, and for anything Vyre drafts on the person's behalf before it is
  stored; `PATTERNS` (same file) for chat's optional lint and "Rewrite plainly" button. Sent.
- Settings UI: `style.enabled`/`style.rules` show up in Settings from the module.json declaration
  alone, no Deck work needed; worth a quick check once someone is in Settings for something else.

## Needs from others

- sessions: call `style.append` at session start, same pickup as `team.project-append` (both
  small, both queued behind sessions' own rc.2 work per the lead).
- chat, capsule-pro: wiring `normalizeProse` into render and into draft-time writes, and the lint
  button (item 3 and 4 of ADR 0037), design and build are theirs; the pure function and pattern
  list are done and ready to consume from `lib/plain-prose.js`.

## Changed contracts

- New module `style` (roles box, local; requires `settings`), tools `style.append`,
  `style.patterns`, `style.rules.check` (internal). No events. Talks to `settings` through
  `ctx.call` only.
- New lib `lib/plain-prose.js` (no feature state, ADR 0033): `PATTERNS`, `splitProse`,
  `normalizeProse`. Imports only the kernel; imported by `core/style`.
- `core/settings`: two new declared keys (`style.enabled`, `style.rules`), no code change to
  `core/settings` itself, just new entries in `core/style/module.json`'s own `settings` list.
