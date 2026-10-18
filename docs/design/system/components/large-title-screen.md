---
title: Large title screen
summary: The page frame of a place: a large title that collapses into the bar on a phone, pull to refresh, one column on a wide screen, and a dock pinned under the page.
audience: builders
owner: app-design
status: draft
---

# Large title screen

The frame of a place such as Home, Projects or Records. It scrolls the page, draws the large title (or lets the page draw its own with `own`), collapses the title into a bar as it scrolls on a phone, and refreshes on a pull.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/motion/LargeTitle.tsx`: `LargeTitleScreen` | built |

## Anatomy

A scrolling column. On a wide screen the content stops at the wide width with a gutter on each side and the title is the first line; on a phone the title is large at the top and a small title with a hairline fades into the bar once the large one has scrolled out.

## Dock

`dock` is a slot pinned under the scrolling page so it stays in view while the page moves. Home puts its ask box there. On a phone it sits directly above the tab bar with a hairline over it and the page's side gutter; on a wide screen it sits at the bottom of the same column as the content, on the page colour. The dock takes any content, one row tall: a field and a button, or a single bar. Nothing else is pinned: the title bar stays at the top.

## States

Idle, refreshing (the pull indicator), scrolled (the small title shown), with or without a dock.
