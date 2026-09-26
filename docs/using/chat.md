---
title: Chat
summary: Use Chat in the Deck to read and type into the sessions Vyre runs, answer their questions inline, and edit held drafts where they appear.
audience: users
owner: polish-surfaces
status: draft
---

# Chat

Chat is the Deck's view of sessions as conversations. Each headless session vyred runs (an
agent's thread, the assistant, a thread you started) appears as a chat: its text streaming as it
is written, its tool calls, file edits as diffs, and anything it needs from you inline. You type
into it like a message box, and the words go to the session as you. Chat lives at `/chat` in the
[Deck](deck.md), on a laptop and on a phone.

## Find a session

Open `/chat`. The main area lists recent sessions, newest first, each with its agent, turn count,
who holds its keyboard, and how many things it needs from you. The rail (on a phone, the page
itself) holds the tree: search, your projects with their sessions, sessions with no project, and
your agents.

| Path | Opens |
| --- | --- |
| `/chat` | recent sessions |
| `/chat/<project>` | the sessions in one project |
| `/chat/<project>/<thread>` | one session, in its project |
| `/chat/thread/<thread>` | one session with no project |

## Read a session

A session's view shows, as they arrive:

- the model's text, growing while it is written, as markdown;
- each tool call as a chip you can open to see its input and output (the last six stay in the
  timeline);
- a file edit as a diff;
- a fact from memory in gold, beside the turn that used it.

## Type into a session

The box at the bottom sends to the session. Enter sends, Shift+Enter makes a new line. `@` opens a
small menu that inserts an agent or session name as text. Anything starting with `/` goes to
Claude Code as is, so its own commands (`/rename`, for example) work.

One surface holds a session's keyboard at a time (its lease). The header says who has it: "No one
is typing", or a name. If another surface holds it, press Take to take it. Your first keystroke
takes it too.

## Answer a question inline

When the session asks permission for a tool, a card appears in the conversation: "juno asks to
...", with the tool and where it acts. Choose Allow or Deny. The card goes away once it is
answered, from here or from any other surface.

## Edit and send a held draft inline

When the session's work is held at the Gate (an email, a payment), the draft appears as a card in
the conversation. Edit its fields in place; your edits are saved to the Gate as you type
(`gate.revise`). Send approves exactly what the card shows, and Discard rejects it. The box may
ask for your passkey first (see [Deck](deck.md#add-a-passkey)).

## Offline

If the box is out of reach, Chat shows the session list from your last visit, with the time it
was saved. The list holds names, ids, projects and times, never a message's words. A session you
opened before may also open from the Deck's offline cache.

## What it will not do

- It does not list sessions you ran by hand in a terminal; those are in
  [Projects and threads](projects-and-threads.md) and in recall. Listing them in Chat is coming.
- It is not a separate chat server. Everything is a call to vyred, so a message typed here is the
  same as one typed in the Capsule or with `vyre threads send`.
- It never renders a session's text as HTML.

## Next

- [Projects and threads](projects-and-threads.md), how sessions are grouped.
- [Agents](agents.md), who runs the sessions.
- [CLI](cli.md#drive-a-running-session), to do the same from a terminal.
