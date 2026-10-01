---
title: Provider badge
summary: The small mark that says which AI account wrote a reply, shown at the lower right of the session or project avatar, in the picker and in tool rows.
audience: builders
owner: app-design
status: draft
---

# Provider badge

A session belongs to Vyre, not to a model: any of the person's signed-in AI accounts can answer in it.
The badge says which one wrote a reply. Drawn in team/0.2/group-chat.html (section 1). New 1 Oct 2026,
for 0.2.0.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none | not built |

## Anatomy

A round or rounded-square mark with a two-letter monogram in mono 600, `-0.04em`, set in the provider's
own shape so it never relies on colour:

| Provider | Shape | Fill | Monogram |
|---|---|---|---|
| Claude | circle | `--hover`, 1 px `--rule-strong` inner ring | Cl in `--text` |
| Codex | rounded square, radius 4 | `--text`, no ring | Cx in `--bg` |
| Grok | teardrop (radius 50% except the lower left, 4) | `--panel`, 1 px `--rule-strong` inner ring | Gk in `--text` |

These are neutral stand-ins. The user has not yet decided whether the vendors' own marks may be used;
until then ship these, and keep the mark behind one function (`providerMark(provider, size)`) so swapping
is a one-file change. A provider Vyre does not know gets a circle with the first two letters of its name.

## Placement

1. **Beside an avatar** (replies, thread rows, the Agents list): the badge is 55 percent of the avatar's
   size, rounded (15 at 28, 22 at 40, 13 at 24, never under 12), at its lower right, offset 4 px outward, with a
   2 px ring in the surface colour so it reads on any ground. The avatar itself (session, project or agent
   per avatar.md) is untouched and keeps its tap behaviour; the badge is not a separate tap target.
2. **On its own** (picker rows, tool rows, block headers): 16 to 22, no avatar, same shapes.
3. **Meta line**: next to the badge the reply's header names "Provider, model, time" in 12 `--label`
   ("Claude, Opus, 14 s"); the badge and this line together are the identity, so a long thread stays
   readable at a glance.

## States and rules

- Switching the model never changes the avatar; only later replies carry the new badge.
- Account labels: when the person has two accounts of one provider, the meta line names the account
  ("Claude, work account"); the badge is the same.
- Accessible name: "Written by Codex, GPT-5" on the badge's container; the monogram is decorative.
- Dark and paper from tokens only; no hue, no motion.

## Data

The badge reads `provider` and `model` from the turn (sessions' per-turn record). Until a turn carries
them it draws no badge, never a guess.
