---
title: Provider badge
summary: The small mark that says which AI account wrote a reply, shown at the lower right of the session or project avatar, in the picker and in tool rows.
audience: builders
owner: app-design
status: draft
---

# Provider badge

A session belongs to Vyre, not to a model: any of the person's signed-in AI accounts can answer in it.
The badge says which one wrote a reply, with the provider's own mark. Drawn in team/0.2/group-chat.html (section 1). New 1 Oct 2026,
for 0.2.0.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none | not built |

## Anatomy

A circular tile (diameter = the badge size) holding the provider's own official mark, unmodified, centred
at 62 percent of the tile's diameter (the mark's wider side; OpenRouter's glyph is wide and fits by width).
The tile is `--hover` with a 1 px `--rule-strong` inner ring on dark, `--hover` on paper with the same
ring, so a mark always sits on a neutral ground and never touches the page.

| Provider | Mark (docs/design/brand/providers/) | On dark | On paper |
|---|---|---|---|
| Claude | Claude Spark | claude-spark-clay.svg (published colour, #D97757) | same |
| Codex (OpenAI) | OpenAI Blossom | openai-blossom-white.svg | openai-blossom-black.svg |
| OpenRouter (the driver) | OpenRouter glyph | openrouter-glyph-cloud.svg | openrouter-glyph-ink.svg |
| Grok (xAI) | Grok logomark | grok-logomark-light.svg (white mark) | grok-logomark-dark.svg (dark mark) |
| Any other provider | none | monogram of the provider's first two letters: mono 600, `-0.04em`, `--text` on a `--panel` tile | same |

Rules for the official marks (from the providers' own guidelines): use the SVGs as published, with no
recolouring beyond the published variants above, no outline, crop, shadow, glow or animation, and leave the
clear space the tile already gives. They identify the provider only: never use them as Vyre branding, never
combine them with Vyre's mark, and never imply the provider made or endorses Vyre. Source URL of every
file and the retrieval date are in docs/design/brand/providers/SOURCES.md.

Keep the mark behind one function (`providerMark(provider, size)`) that picks the file by provider and
theme; native-core's deck/js/provider-mark.js already has that shape, so this is a swap of what it draws.

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

Every `thread.turn`, `thread.text`, `thread.thinking`, `thread.usage` and `thread.finished` event carries
`payload.provider` ("claude", "codex", "grok", "openrouter"), `payload.model` (the string the provider
reported, null until its init, for example "grok-4.7" or "gpt-6.1-sol[low]") and `payload.account` (an id);
`thread.tool` carries `provider` too (sessions, 1 Oct). The badge needs `provider`; the meta line reads
"Provider, model, time".

- The model string is shown exactly as reported, never prettified or guessed; while it is null the meta
  line shows the provider alone ("Codex, 9 s") and fills in the model when it arrives, without moving the
  text.
- Usage and cost appear in the meta line only when the provider reports real numbers. Zeros or missing
  usage are never shown as "0 tokens" (Codex and Grok report none over ACP today): the line simply omits
  them, and the cost line for media turns appears only when the number is known.
- A turn with no `provider` draws no badge, never a guess.
