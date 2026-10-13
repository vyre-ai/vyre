---
title: Message actions
summary: The per-message actions as one quiet icon row with a menu for the rare ones, and the transcript keyboard that drives it.
audience: builders
owner: app-design
status: draft
---

# Message actions

Under every message one icon row (hidden until the message is hovered, keyboard-focused or long-pressed; its room is kept so nothing jumps): **Copy** (Shift-click copies as Markdown), **Reply**, **Ask about this**, and **...**, a menu with Copy as Markdown, Copy code, Edit and Retry (your own), Branch from here, React and Pin. Each icon has a tooltip with its name and key.

Keyboard: Alt+Up in the message box selects the last message; Up and Down move; R reply, C copy, Shift+C copy as Markdown, A ask about it, E edit your own, B branch, P pin, M open the menu; Esc returns to the box. The key decisions are pure (`apps/app/src/chat/message-keys.js`).

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/src/chat/MessageBar.tsx`, `ChatRows.tsx` (`useMessageKeys`) | built |
