---
title: Chat
summary: Use Chat in the Deck to read and type into the sessions Vyre runs, answer their questions inline, and edit held drafts where they appear.
audience: users
owner: polish-surfaces
status: draft
---

# Chat

Chat is the Deck's view of sessions as conversations. It lists every Claude Code session on the
machine that serves the Deck (normally your box): the ones you ran in a terminal, and the headless
ones vyred runs (an agent's thread, the assistant, a thread you started). A session shows its text
as it is written, its tool calls, file edits as diffs, and anything it needs from you, inline. You
type into it like a message box, and the words go to the session as you. Chat lives at `/chat`
in the [Deck](deck.md), on a laptop and on a phone.

## Find a session

1. Open `/chat` (on a phone, the Chat tab). The main area lists sessions, newest first, each
   with its agent, turn count, who holds its keyboard, and how many things it needs from you.
2. Pick one, or use the rail (on a phone, the page itself): search, your projects with their
   sessions, sessions in no project, and your agents' threads.

A session in two projects is listed under both. A new session, a rename or a new turn shows up
on its own, without a reload.

| Path | Opens |
| --- | --- |
| `/chat` | every session, newest first |
| `/chat/<project>` | the sessions in one project |
| `/chat/<project>/<thread>` | one session, in its project |
| `/chat/thread/<thread>` | one session in no project |

## Read a session

A session's view shows, as they arrive:

- the model's text, growing while it is written, as markdown;
- each tool call as a chip you can open to see its input and output (the last six stay in the
  timeline);
- a file edit as a diff;
- a fact from memory in gold, beside the turn that used it.

A session you run in a terminal is read from its transcript, and Chat adds each turn when the
turn completes, not word by word.

## Type into a session

1. Type in the box at the bottom. Enter sends, Shift+Enter makes a new line.
2. `@` opens a small menu that inserts an agent or session name as text.
3. Anything starting with `/` goes to Claude Code as is, so its own commands (`/rename`, for
   example) work.

One surface holds a session's keyboard at a time (its lease). The header says who has it: "No one
is typing", or a name. If another surface holds it, press **Take**. Your first keystroke takes it
too.

Typing into a session you started in a terminal makes vyred resume it headless from then on.

> [!SNAG] "This session is open somewhere else"
> Only one process may write a session's transcript. vyred refuses while the session is still
> open in a terminal (or wrote to its transcript in the last 30 seconds). Close it there, or type
> there.

> [!SNAG] "... ran in <folder>, which is not here"
> The session's folder does not exist on the machine serving the Deck, so it cannot be resumed
> there. Type into it on the machine where it ran.

## Answer a question inline

When the session asks permission for a tool, a card appears in the conversation: "juno asks to
...", with the tool and where it acts. Choose Allow or Deny. The card goes away once it is
answered, from here or from any other surface.

## Edit and send a held draft inline

When the session's work is held at the Gate (an email, a web request), the draft appears as a card
in the conversation.

1. Edit its fields in place. Your edits are saved to the Gate as you type (`gate.revise`).
2. Press **Send** (Command-Enter) to approve exactly what the card shows, or **Discard** to reject
   it.

The box may ask for your passkey first (see [Deck](deck.md#add-a-passkey)). If the send fails,
the card says "failed:" with the reason, and Send tries again.

## When the box is out of reach

Chat shows the session list from your last visit, with the time it was saved. The list holds
names, ids, projects and times, never a message's words. A session you opened before may also open
from the Deck's offline cache.

## What it will not do

- It is not a separate chat server. Everything is a call to vyred, so a message typed here is the
  same as one typed in the Capsule or with `vyre threads send`.
- It never renders a session's text as HTML.
- It lists only the sessions on the machine that serves the Deck. The box's Chat does not show
  sessions you ran on your Mac; use `vyre threads` there.

## Next

- [Projects and threads](projects-and-threads.md), how sessions are grouped.
- [Agents](agents.md), who runs the sessions.
- [CLI](cli.md#drive-a-running-session), to do the same from a terminal.
