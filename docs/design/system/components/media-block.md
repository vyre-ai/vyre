---
title: Media block
summary: An image, video or audio a provider makes, shown inline in its reply and saved in the project as an artifact. Ships in 0.2.0 only if artifacts lands in time.
audience: builders
owner: app-design
status: draft
---

# Media block

What a provider generates appears inline in its reply and is saved in the project as an artifact
(provider, prompt and session recorded), so any model and anyone with the project's permission can open
and reuse it. Drawn in team/0.2/group-chat.html (section 5). New 1 Oct 2026. Depends on artifacts; if
that is not in 0.2.0, the block is a plain file row (file-preview.md) until it is.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none | not built |

## Anatomy

A block inside the reply, `--bg`, 1 px `--rule`, radius 12:

1. **Media**, at the reply's width: an image at its own aspect ratio (max height 420, tap or click opens
   the artifact panel), a video with a poster and a play control (no autoplay), audio as a 44 tall
   player. The picture itself is the model's work and is shown as made, with no filter or frame inside it.
2. **Caption row**, 36 tall, hairline above: the item's title (12/600 `--text`) and, at the right,
   "Saved in <project>" (11 `--label`).
3. **Actions**, a row of ghost buttons: **Open** (the artifact panel), **Use in <model>** (hands the item
   to another account by reference), **Copy link**.
4. **Meta**, in the reply's header: "Provider, image, 11 s", and the cost for media turns.

## Using an item again

Another model is handed the item by a # chip in the composer, "image from Grok" (component 15's Artifacts
kind, with the provider in the meta). "Use in Codex" inserts that chip and switches the composer's chip
to Codex for the turn.

## States

- **Making**: a quiet placeholder at the final aspect ratio (`--hover`), "Making an image" in 12
  `--text-2`, and a Cancel ghost; no spinner.
- **Failed**: the placeholder reads "Could not make the image. Try again." with Try again; the provider's
  own message is under it in `--label`.
- **Not allowed or removed**: "This item is no longer in the project." with the project's name.
- Dark and paper from tokens for the frame; the media is not recoloured.

## Rules

An item is an ordinary artifact of the project (kind image, video or audio) reached through the project's
own permission, never a separate store. The look inside the item belongs to the model that made it
(artifact-card.md, frame and content); only this frame is Vyre's.
