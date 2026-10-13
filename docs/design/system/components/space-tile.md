---
title: Space tile
summary: A space's mark: its uploaded logo cropped to a rounded square, else a monogram on a calm tint.
audience: builders
owner: app-design
status: draft
---

# Space tile

`SpaceTile` (`ui/components/SpaceTile.tsx`), rules in `ui/marks/space-tile.js`, `logo.js`. Used wherever a space appears, including the Avatar's space badge.

- Logo: PNG, JPEG or WebP under 5 MB, cropped to a centred 128 px square, kept in the space's look (`logo`). `LogoPicker` offers Upload and Remove in the space's Settings and at creation.
- No logo, or it fails to load: initials (two letters) on one of 8 tints (sage, clay, slate, sand, plum, teal, rose, stone), chosen by the space id so a rename never changes it. Paper and dark forms, contrast 4.5 to 1 or better.
- Radius 28 percent of the size. Never the generated pattern.
