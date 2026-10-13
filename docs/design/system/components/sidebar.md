---
title: Sidebar
summary: The Quiet sidebar: main places, AI and Build groups, drill-in panels with Back, a slim folded rail, search in the footer.
audience: builders
owner: app-design
status: draft
---

# Sidebar

Library: `Shell` (rail), `SidebarRow`, `SidebarPanel`, `Tip`; numbers in `apps/app/ui/shell/rail-tokens.js`; rules in `rail-state.js` and `sidebar-stack.js`.

## Structure
Top: space switcher (logo or monogram, name, address). Places: Now, Chat, Projects, Records, Drive. Group "AI": Agents, Flows. Group "Build" (owners and admins only): Templates, Record types, Kits. Foot: Settings, Collapse, then search icon, your face, name and address on one row. Everything else lives under Settings.

## Rows
38 high, radius 10, icon 18, label 15. Current row: raised fill, medium text. Count badge on Now only.

## Folded
Cmd or Ctrl and backslash, or the Collapse row. Width 64, icons only, each named by a `Tip` on hover and focus. Search sits directly above the face. Remembered per device (`vyre.rail.collapsed`).

## Drill-in
A path inside Projects, Chat, Records, Drive, Agents, Flows or Settings turns the sidebar into that place's panel: Back, search, list grouped (current marked). Back, Escape and the browser back all leave it; `?side=main` keeps the page with the main sidebar. A panel slides (180 ms; none under reduced motion). Slots `before` and `after` carry Records' pinned views, "All record types", "New view".

## Page width
`--page-max` 1120, `--gutter` 40 (16 on a phone), top padding 32.
