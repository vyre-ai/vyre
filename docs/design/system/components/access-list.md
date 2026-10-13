---
title: Access list
summary: Who has something and at which level, Can use or Can edit; each row changes its level or removes the person, and Add lists the people and assistants not yet on it.
audience: builders
owner: app-design
status: draft
---

# Access list

The one list for sharing: Vault items first, then flows, agents and projects. Two levels, in the same words everywhere: Can use and Can edit.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/AccessList.tsx`, exported from `@vyre/ui` | built |
| Deck, Lumen | not used | |

## Anatomy

A dense row per person or assistant: an avatar (32), the name, the level in `--label`, and a menu button at the end holding Can use, Can edit and Remove. Under the rows,
"Add a person or assistant" opens a menu of the candidates not yet listed, each with both levels. With nobody on it the list says "Only you."

## Behaviour

Sharing a person again replaces the level; it never doubles the row. Sharing is a grant on the item and never shows the value. Removing a person takes the grant away at once.
