---
title: "ADR 0037: A house writing voice for every session"
summary: A system-prompt block, on by default, that bans AI writing tells (em dashes, throat-clearing, sycophancy, hedging) in every Vyre-owned session; a display-side normaliser gives em dashes a hard guarantee in prose Vyre shows or writes itself.
audience: builders, agents
owner: teammates
status: draft
---

# ADR 0037: A house writing voice for every session

Status: proposed, 28 Sep 2026, workstream: style, builds on: ADR 0030 (Vyre-owned sessions,
the append), ADR 0031's `team.project-append` (the pattern this reuses).

## Context

The user's own writing rules (`stop-slop/SKILL.md`, and years of correcting the same tells in
chat) are not enforced anywhere: main sessions, teammates and subagents each drift back to
throat-clearing openers, em dashes, reflex three-item lists, and closing offers nobody asked
for. ADR 0031 section 1 already solved a version of this problem for teammate steering
(`team.project-append`, injected at session start next to the project brief): one small tool
that computes a system-prompt string, with a person-only setting to turn it off. Style reuses
that shape exactly, rather than inventing a second injection mechanism.

## Decision

**`core/style`, a new module (roles box, local, requires `settings`), computes the append text
every session gets. Storage for on/off and the free-text addition is not this module's own
table: `style.enabled` and `style.rules` are ordinary `core/settings` declarations (account
default plus a per-project override), so `settings.get`/`settings.set` already give a person the
on/off switch and the text box, person-only to set, with no new code here for that half.**

- **`style.append`**: `{project?} -> {text}`. A fixed house-voice block (below), plus the
  person's own free-text rules appended when they have set any, or `null` when the person has
  turned style off for that scope (a project's setting overrides the account default; with
  neither set, style is on). Called by `sessions` at session start for every session kind (main,
  teammate, subagent, job), next to `team.project-append`; one call site injects both. Same
  `callers` reasoning as `team.project-append`'s reviewer LOW: only a person's own surface or
  sessions calling as itself ("module") may reach it, since it names a project.
- **`style.rules` is capped at 500 characters** (well under `core/settings`' generic
  4000-character string default), checked by `style.rules.check` (module.json's `check.tool`),
  so a person's addition stays an addition, not a second house voice. Only a person ever writes
  it: `settings.set` is already person-only, and no other path exists (`settings.write`, the one
  module-write path, refuses a key that names a `check`, and `core/style` never calls it itself).
- **The banned-pattern list, and the normaliser, are code, not a database, and they live in
  `lib/plain-prose.js`**, not `core/style` itself: a lib, not a module (ADR 0033), so the Deck,
  the Capsule's web views and core can all import them directly, with no module dependency.
  `core/style`'s `style.patterns` tool serves the same list over the wire, for a caller that
  cannot import a file. The house-voice text is a separate fixed string, in
  `core/style/index.js`, sourced from `stop-slop/SKILL.md` but written in Vyre's own words. A
  person edits only their own free-text addition (`style.rules`); changing either fixed list is a
  code change, reviewed like any other.
- **What the block bans**, each with a plain instruction, not a list a person reads in the
  prompt: em dashes entirely (a comma, a colon or a period instead); throat-clearing openers
  ("Here's the thing", "It turns out") and empty emphasis ("Let that sink in", "Full stop");
  "It's not X, it's Y" framing; three-item lists used as a reflex, not because three is the right
  count; business words ("leverage", "delve into") where a plain one exists; sycophancy
  ("You're absolutely right"); closing offers nobody asked for ("Let me know if you'd like...");
  restating the question; summarising what was just done twice; more than one apology for the
  same thing; a stack of hedges instead of one qualification. It asks for plain, specific,
  active voice that names who does what, matching `stop-slop/SKILL.md`'s own rules (cut filler,
  active voice, be specific, vary rhythm, trust the reader). Kept to about 150 words (team-lead's
  call: a long style prompt costs tokens on every turn) and, since it asks a model not to do
  these things, checked that it does not do them itself (no em dash, no reflex triad).

**The em-dash hard guarantee is display-side, not the model's to get right every time.**
`lib/plain-prose.js`'s `normalizeProse` walks prose runs only, never a fenced code block, inline
code, or (given the caller's own split) tool output, and replaces an em dash with the
punctuation the sentence actually needs: a paired dash (the aside form, "A, B, C" with two
dashes) becomes parentheses; a single remaining one becomes a comma, which reads correctly
wherever a dash was doing a pause, an explanation or an aside, and never leaves a sentence
fragment the way a period could if the two sides are not full clauses on their own. Two places
run it, both chat's and capsule-pro's to build: chat, the Capsule and notifications, on render;
and anything Vyre drafts on the person's behalf (a note, a notification, a commit message it
writes) at the point it is written, before it is stored. The transcript itself keeps the model's
raw text unmodified: the normaliser is a display and drafting rule, never a rewrite of what a
session actually said.

**Optional, cheap: a lint, not an auto-fix.** Chat may mark a finished message that still
matches a banned pattern, with a "Rewrite plainly" button a person taps; nothing regenerates on
its own, since that spends tokens the person did not ask to spend. `lib/plain-prose.js` exports
the pattern list as data (regexes with a label) so chat can match against a finished message
without re-implementing the list; `core/style`'s `style.patterns` serves the same list for a
caller that cannot import the file directly.

## What ships, and by whom

1. **style (`core/style`, `lib/plain-prose.js`)**: done. `style.append`, `style.patterns`, the
   fixed house-voice text, `style.enabled`/`style.rules` as `core/settings` declarations, the
   500-character cap, `lib/plain-prose.js`'s pattern list and `normalizeProse`. Tests on the fake
   driver plus the lib's own pure tests.
2. **sessions**: call `style.append` at session start next to `team.project-append`, for every
   session kind. Queued behind sessions' own work, same as `team.project-append`.
3. **chat, capsule-pro**: the em-dash normaliser's actual wiring into render and into what Vyre
   drafts (the pure function is done, in `lib/plain-prose.js`, ready to import); the optional
   lint and "Rewrite plainly" button in chat.

## Non-goals here

- No database of banned patterns a person edits row by row; only their own free-text addition is
  stored.
- No automatic regeneration of a message that breaks a rule; the lint offers, it never rewrites
  on its own.
- No change to the transcript's raw text; the em-dash guarantee is display and drafting only.
