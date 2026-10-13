---
title: Chats
summary: A chat is one thread of messages between people and agents in a Space, with its own key, tags, project and per-message actions.
audience: builders, agents
owner: docs
status: stable
---

# Chats

## What it is

A chat is a conversation thread. People and agents are both participants, and the model answers inside it as an agent.
The `switchboard` module (`core/switchboard`) runs the threads. The Space keeps each chat as a record of type `chat-record`.

## What a person sees

- **Chats** list at `/u/chats` (`apps/app/screens/chats/ChatsScreen.tsx`): title, project, the people and agents in it, the providers that answered, a status (working, idle, stopped, failed) and a **Needs you** chip when it waits on you.
- **New chat** at `/u/chats/new` starts a chat with the assistant or an agent. One chat opens at `/u/chats/<id>`.
- **Filter by tag**: a row of tag chips above the list. Search also matches title, project, people, agents and tags (`apps/app/screens/chats/chats-model.js`).
- **Composer** (`apps/app/src/chat/ChatComposer.tsx`): `@` lists people, agents and files, and `#` lists the kinds other modules offer (vault items, Drive files, artifacts, GitHub, records). Enter sends.
- **Message actions** (`apps/app/src/chat/MessageBar.tsx`): Copy, Reply, Ask about this, and a menu with Copy as Markdown, Copy code, Edit, Retry, Branch from here, React and Pin. They show on hover, keyboard focus or long press.
- **Chat menu** (`apps/app/screens/chats/useChatMenu.tsx`): Open, Rename, Move to a project, Archive, Delete.
- A question an agent asks shows as one card in the chat (`apps/app/src/chat/QuestionsCard.tsx`), and a held send shows as a card for the person to approve.

## How it works

**Data.** The `chat-record` type (`records/core-types.js`) holds `title`, `project`, `about` (any record the chat is about), `shared` (shown on that record's timeline), `chat` (id), `people`, `agents`, `former` (participants who could not move with it), `started`, `last_active`, `status`, `drive`, `location` and `tags`. A chat is private to its people until `shared` is set.

**Tools.** The switchboard manifest (`core/switchboard/module.json`) exposes `threads.start`, `threads.send`, `threads.list`, `threads.get`, `threads.rename`, `threads.archive`, `threads.unarchive`, `threads.delete`, `threads.stop`, `threads.interrupt`, `threads.queue`, `threads.unqueue`, `threads.send-now`, `threads.fork`, `threads.branch`, `threads.edit`, `threads.edit-retry`, `threads.retry`, `threads.rewind`, `threads.undo-edit`, `threads.asks` and `threads.answer`. Each carries a `reach`: most are `anyone`, while `threads.branch`, `threads.edit`, `threads.retry`, `threads.edit-retry`, `threads.undo-edit`, `threads.unqueue`, `threads.shell` and `threads.remember` are `person`, and the lineage, claim and transcript helpers are `modules`.

**One typist.** `threads.lease` and `threads.release` (`core/switchboard/lease.js`) give one surface a chat's keyboard at a time. The app offers **Take over** when another surface holds it.

**Tags with #.** A record picked with `#` travels as `{ kind: "record", id }` in a send's `mentions`. `core/switchboard/record-tags.js` checks the id is a record in this Space and reads it under the sender's own chain through `records.reference`, so a record the sender cannot read is not a tag and stays plain text. The model sees the record as data, with sealed parts as `{{field:<urn>#<name>}}` placeholders. `core/mentions` fans a search out to every provider as the asker, within `SEARCH_MS` (400 ms), and returns names only. `mentions.resolve` is for sessions and the assistant, never a model.

**Tags on a chat.** `tags` is a field on the `chat-record` type, so a chat is a taggable record. `/u/tags/<tag>` (`apps/app/screens/tags/TagScreen.tsx`) lists every record type that carries `tags`, chats included, and can be pinned to the sidebar.

**Private chats.** Each chat has a ring: epochs of a random key wrapped to the device keys of the people in it (`lib/chat-keys.js`). Files have a key of their own under the chat's key, and file names are encrypted. A server holds documents and ciphertext, never a key. Owners and admins who are not in the chat are refused. Removing someone rotates the key. Sharing one file to the chat's project is a grant that wraps the file key to the project's ring, not a copy.

**Checks on a call.** The switchboard runs under the caller's chain: the person, then the agent they started. Reads and sends go through the gateway, so grants and project access (`core/switchboard/project-access.js`) apply. A held send (mail, post, payment) from the chat goes to the Gate and waits for the person.

**Events.** `thread.questions` carries an ask card. The caller list for `ask.many` and `ask.answer` is in `core/ask/index.js`: an agent may ask, only a person surface may answer.

## Where the code lives

- `core/switchboard/` : threads, leases, queue, edits, branches, record tags, project access.
- `core/mentions/` : the `#` picker (`mentions.kinds`, `mentions.search`, `mentions.resolve`).
- `core/ask/` : one card of several questions in a chat (`ask.many`, `ask.get`, `ask.answer`, `ask.cancel`).
- `core/attachments/` : files added to a message.
- `lib/chat-keys.js` : per-chat keys and file sharing to a project.
- `records/core-types.js` : the `chat-record` type.
- `apps/app/screens/chats/` : list, new chat, chat model, chat menu.
- `apps/app/src/chat/` : the chat view, composer, message bar, question card, previews.
- `apps/app/screens/tags/` : the tag pages.

## How agents use it

- An agent reads and writes threads through `threads.*`, within its own grants. `threads.send`, `threads.list` and `threads.get` are open to it. The edit, retry and branch tools are `person` only.
- An agent asks a person several things at once with `ask.many`, then polls `ask.get`. `ask.answer` is person only.
- An agent wanting to send mail, post or pay files it with `gate.request`, see [Gate](./gate.md).
- See tools (agent doc "tools"), authority (agent doc "authority") and sessions and context (agent doc "sessions-and-context").

## Limits today

- A Viewer's AI can read a project's records and files through Vyre but cannot open the project's folder directly (docs/known-gaps.md).
- You can hand one message to several models and see each answer in its own block. Only that fan-out is proven; plans, diffs and terminals look the same for every provider (docs/known-gaps.md).
- Notifications when the phone app is closed: only web push works today (docs/known-gaps.md).
- While an agent works in a private chat on a server, that server's operator could see the chat in use (docs/using/private-chats.md).

## Related

- [Agents](./agents.md), [Sessions and models](./sessions-and-models.md), [Gate](./gate.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Files](./files.md)
- [Map](../map.md), [Overview](../overview.md)
- [Chat](../../using/chat.md), [Private chats](../../using/private-chats.md), [Projects and threads](../../using/projects-and-threads.md)
- [Floor](../../concepts/floor.md), [Presence](../../concepts/presence.md), [Tools reference](../../reference/tools.md)
