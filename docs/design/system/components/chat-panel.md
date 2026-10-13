---
title: Chat panel
summary: The one panel for everything about a chat, a right-side panel on a wide screen and a sheet on a phone, replacing the two "In this chat" sheets.
audience: builders
owner: app-design
status: draft
---

# Chat panel

One entry (the chat header, its row or its "more" button), one panel. Sections: **People** (members and AIs, add a teammate), **About** (the project with "Move to a project", the linked record with "Link to a record", what assistants can see and the sealed chip), **How it answers** (effort, thinking, mode, who replies in a shared chat), **Where it runs** (this Mac or the server, move, carry on here, terminal), **Around it** (files, running here with a live count, context used, transcript and recall, fork, go back). Mute and Pin are quiet icon buttons in the header.

"Answering" (which AI replies to the next message) stays in the composer: it is per message. The panel holds the chat's standing settings.

Keyboard: Up, Down, Home and End move between rows; a letter jumps to the next row that starts with it; Enter opens; Esc goes back, then closes (the chat's own Esc, stop the turn, is off while the panel is open). The project page is a combobox: type to filter, Up and Down, Enter moves, Esc goes back. `/move` opens that page.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/src/chat/ChatPanel.tsx`, `useChatProject.ts` (projects.list, projects.add-threads, projects.remove-threads) | built |
