---
title: Picker list
summary: The one list under the composer for / commands, @ people and AIs, # records, the + menu and the Answering list, driven from the box by keyboard.
audience: builders
owner: app-design
status: draft
---

# Picker list

One list, five uses: `/` commands, `@` people and AIs, `#` records, files, projects and tags, the `+` menu, and the Answering list. The message box keeps the focus (a combobox);
the list only draws rows, marks the active one and scrolls it into view.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/PickerList.tsx`, keyboard model `apps/app/ui/lib/picker-model.js` | built |

## Split of the triggers

`@` is who: people, assistants and agents. `#` is what: records (their rows), projects, files and tags. `/` is a command. The footer of the open list says so.

## Keyboard

Type to filter (prefix first, then contains). Up and Down move and wrap. Enter or Tab picks. Esc closes and leaves the words. Backspace on an empty query closes (and deletes the trigger
character). The active row scrolls into view. In the `+` and Answering menus typed characters filter the menu, not the message. Right opens a model list from an Answering row; Left goes back.
A picked mention is written as `@Name` or `#Name` (in quotes when the name has a space), shown as a chip above the box, and Backspace right after it deletes the whole token.

## Accessibility

The box is `role=combobox` with `aria-expanded`, `aria-controls`, `aria-autocomplete=list` and `aria-activedescendant` naming the active row. The list is `role=listbox`; each row is
`role=option` with `aria-selected` and an id `<list>-opt-<n>`. Rows are 40 high (48 on a phone). A press on a row does not take the focus from the box.
