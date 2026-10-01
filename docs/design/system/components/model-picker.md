---
title: Model picker
summary: The composer chip that says which of your AI accounts answers, its popover, @codex style mentions for one turn, and the switch line left in the thread.
audience: builders
owner: app-design
status: draft
---

# Model picker

Choose who answers, at any time, without leaving the session. Drawn in team/0.2/group-chat.html
(sections 1 and 2). New 1 Oct 2026, for 0.2.0. ("Ask two" is 0.2.1 and is not specified here.)

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none | not built |

## Anatomy: the chip

In the composer's bar, at the left: a 30 tall pill (`--panel`, 1 px `--rule-strong`, radius 999, padding
0 10 0 6) holding the provider badge at 18, the provider name (or the account label when the person has
several accounts of one provider) in 12 600 `--text`, and a 16 chevron in `--label`. Tapping it opens the
popover (a sheet on the phone). With one signed-in account the chip still shows who answers but has no
chevron and does nothing.

## Anatomy: the popover

340 wide on the desktop (a sheet with the same rows on the phone), radius 14, `--panel`, 1 px
`--rule-strong`, soft shadow. A 11 `--label` header "Answer with". One row per signed-in account, 44
tall, padding 8 14: badge 22, a column with the account's name (13/600) and its plan and models (11
`--label`, "Max plan, Opus, Sonnet"), and a check at the right on the current one; the current row sits on
`--hover`. A footer line, 11 `--label` under a hairline: "Any account you have signed in appears here.
Add one in Settings." with "Settings" as a link. Keyboard: Up and Down move, Enter chooses, Esc closes;
on the phone, tap a row.

## Behaviour

1. **Choosing** an account changes who answers from the next turn. It never starts a new session and
   never changes the avatar. It leaves one switch line in the thread (below).
2. **Which models** a row lists comes from the account's provider (sessions' providers list); a model
   the account cannot use is not listed.
3. **Memory and files** carry over: the switch line says so, and it is true because the session is
   Vyre's (sessions' switchProvider and iq's memory context).
4. **Defaults**: the chip starts as the last account used in this session; a new session starts as the
   account the person chose in Settings as their default.
5. **No account**: if a chosen account has no usage left or has signed out, the composer says so in
   plain words above the chip ("Claude has no usage left. Choose another account.") and sending is held
   until the person chooses. It never falls back to another account silently.

## Mentions for one turn

Typing `@codex`, `@grok` or `@claude` (or `@` and an account label) in the composer asks that account for
this turn only; the chip does not change. The @ picker already used for agents shows accounts in its own
group, "Accounts", with the badge and name; choosing one inserts a chip like an agent mention
(`@Codex`). The reply carries that account's badge as any reply does, and no switch line is added, since
the person did not change the session's account.

## The switch line

When the answering account changes between two replies, one line sits between them: hairlines either
side, 12 `--label`, centred, "Switched to Codex. It has this session's memory and files." It is a notice,
not a message: no avatar, not selectable as a turn, and never repeated when the same account answers
again. If memory could not be carried (a provider that cannot take it), the line says what it could not:
"Switched to Grok. It has this session's files, but not its memory yet."

## States

Loading the account list is a three-row skeleton (`--hover` bars); an error is one line in the popover
("Could not read your accounts. Try again."). Dark and paper from tokens only; no colour, no motion beyond
the popover's 120 ms fade (none with reduced motion).

## Data

`providers.list` (accounts, plans, models, signed-in state), the session's current account, and
`threads.mention` for the one-turn route.
