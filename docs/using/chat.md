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
in the [Deck](deck.md), on a laptop and on a phone. On a box with a paired Mac, Chat also lists
the Mac's sessions, which you can read but not type into (see
[Sessions from your Mac](#sessions-from-your-mac)).

## Find a session

1. Open `/chat` (on a phone, the Chat tab). The main area lists sessions, newest first, each
   with its agent, turn count, who holds its keyboard, and how many things it needs from you.
2. Pick one, or use the rail (on a phone, the page itself): search, your projects with their
   sessions, sessions in no project, and your agents' threads.

A session in two projects is listed under both. A new session, a rename or a new turn shows up
on its own, without a reload.

![Chat in the Deck: recent sessions with their turn counts and projects, and every session by project in the rail](shots/deck-chat.png)

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

One surface holds a session's keyboard at a time (its lease). The line above the conversation
says who has it: "No one is typing", "You have the keyboard here", or another surface's name with
"has the keyboard". If another surface holds it, press **Take**. Your first keystroke takes it
too. What you send shows as yours, and the session's replies as claude's (or the agent's name).

On a phone, Enter makes a new line and the send button sends.

If the session is busy in your terminal, the message waits instead of failing: a line above the
box says "Queued for" the session's name, and the message goes in when that turn ends. A queued
message cannot be taken back yet.

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

The first Send may ask for your passkey (see [Deck](deck.md#add-a-passkey)); one proof covers
30 minutes on this device. Editing and Discard ask for nothing. If the send fails,
the card says "failed:" with the reason, and Send tries again.

## Open a terminal on the box

Press **Folders** at the top of Chat, go to a folder, and press **Open in terminal**. A shell
opens in that folder on the box, in the Deck. It asks for no passkey: it is your own screen.
Agents, tailnet guests and Claude's sessions can't open one.

A terminal belongs to the screen that opened it; another device can't pick it up. It outlives
your connection:

- Close the tab or lose the network, and the shell keeps running. Come back and the Deck picks
  up where it left off, with its own scrollback: the box sends only what this screen missed. The
  box keeps the newest 1 MB of output; if more than that went by while you were away, a dim line
  says how much output was not kept, and the rest follows.
- Keys you type while the link is down are held, up to 4 KB, and sent once the terminal has
  caught up. The screen dims until then. Past 4 KB it says which keys were not kept.
- With nobody looking at it, it is kept for 12 hours, then ended. Change that with the config
  key `term.keep_hours`.
- On a box, the shell survives vyred restarting, and the screen reattaches at once. Updating the
  box ends it: the terminal says "The box was updated and this terminal was closed." with a
  button, **Open a new terminal here**, for a new one in the same folder.
- Typing `exit` ends it at once.

When the same terminal is open in two windows, the first one sets its size. The other draws at
that size, scaled to fit, and says "Watching at" the size, with **Take size** to size the
terminal to that window instead.

On a phone, a key bar under the terminal gives Esc, Tab, Ctrl, Alt, the arrows and Paste.

On a Mac, the terminal ends when vyred stops.

## Sessions from your Mac

With a Mac paired, the box's Chat lists the Mac's sessions and projects beside its own, newest
first, each with a chip that names the Mac, for example `alex-mac`
([ADR 0021](../adr/0021-box-reads-the-mac.md)). Open one and its turns load from the Mac; the box
keeps no copy.

A Mac session is read-only here. In place of the box to type into, it says "On alex-mac. Open it
there to continue." Continue it on the Mac.

When the Mac cannot be reached, the Chat header shows a dashed "alex-mac offline" chip and lists
only the box's sessions.

## When the box is out of reach

Chat shows the session list from your last visit, with the time it was saved. The list holds
names, ids, projects and times, never a message's words. A session you opened before may also open
from the Deck's offline cache.

## What it will not do

- It is not a separate chat server. Everything is a call to vyred, so a message typed here is the
  same as one typed in the Capsule or with `vyre threads send`.
- It never renders a session's text as HTML.
- It does not type into a session on your paired Mac. The box's Chat shows those sessions
  read-only; sending to one from the box is not built yet.

## Next

- [Projects and threads](projects-and-threads.md), how sessions are grouped.
- [Agents](agents.md), who runs the sessions.
- [CLI](cli.md#drive-a-running-session), to do the same from a terminal.
