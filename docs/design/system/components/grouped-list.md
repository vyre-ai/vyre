---
title: Grouped list
summary: Items in named groups that can be added, renamed, reordered and collapsed. The one component every sectioned list uses.
audience: builders
owner: app-design
status: draft
---

# Grouped list

Owner's rule: "make groups of everything". One component, reused: record-type fields ("Client details", "Assets"), stage tasks, flows, pinned views, agents.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/GroupedList.tsx`; pure half `groups.js` (tested) | draft, exported from @vyre/ui |

## Shape

`<GroupedList groups items renderItems onChange? itemNoun? />`

- `groups`: `{ name, collapsed? }[]` in the order shown. Stored with the thing that owns the list (for a record type: `groups` on the type).
- `items`: anything with an optional `group` (a group name). No `group`, or a group that no longer exists, means the **default section**: shown first, no header.
- `renderItems(items, group)`: draws one section's items. The component never draws an item itself, so a list keeps its own rows (`FieldRows`, `TaskCard`, a Row).
- `onChange({ groups, items })`: given, the headers get a menu (Rename, Move up, Move down, Delete group) and the list ends with "Add a group". Omitted, the list is read-only: headers still collapse. Used on the record page and in forms.

## Rules (in `groups.js`, tested)

Names are trimmed, never blank, never twice (any case). Rename changes the group and every item in it together. Delete group moves its items to the default section, none is lost. No groups at all draws one flat section with no header. An empty group still shows ("No fields in this group.") so a person can fill it. A group is presentation, never a permission.

## Moving an item between groups

Set the item's `group` from where the item is edited (the field editor has a Group picker). Drag between groups is a later addition; the stored shape does not change.

## Anatomy

Header: chevron (16) and name (strong) and a count Chip; a more button at the end when editable. 44 high touch row; sections gap 12 (s3), items gap 8 (s2). No values of its own: Icon, Chip, Field, Menu, Button, Text from the library.
