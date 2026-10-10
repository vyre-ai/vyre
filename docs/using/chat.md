---
title: Chat
summary: Use Chat in the Vyre app, on your laptop or your phone, to read and type into the sessions Vyre runs on your server, pick which provider and model answers, and answer their questions inline.
audience: users
owner: polish-surfaces
status: draft
---

# Chat

Chat is the Vyre app's view of sessions as conversations, on a laptop and on your phone. It lists
every session on the machine that serves the app (normally your server): the Claude Code
sessions you ran in a terminal, and the ones Vyre runs for you on Claude, Codex, Grok or
OpenRouter (an agent's thread, the assistant, a thread you started). A session shows its text
as it is written, its tool calls, file edits as diffs, and anything it needs from you, inline. You
type into it like a message box, and the words go to the session as you. Chat lives at `/u/chats`
in the Vyre app. On a server with a paired Mac, Chat also lists the Mac's sessions, and
a message you type into one goes to the Mac (see [Sessions from your Mac](#sessions-from-your-mac)).

## Find a session

1. Open **Chat** (`/u/chats`). It lists every chat, the ones that need you first, each with its
   title, the assistants and people in it, the providers that answered, and a **Needs you** chip
   when it waits on you.
2. Pick one to open it. **New chat** (`/u/chats/new`) starts one with your assistant or an agent.

| Path | Opens |
| --- | --- |
| `/u/chats` | every chat |
| `/u/chats/new` | a new chat |
| `/u/chats/<id>` | one chat |

## Read a session

A session's view shows, as they arrive:

- the model's text, growing while it is written, as markdown;
- each tool call as a chip you can open to see its input and output (the last six stay in the
  timeline);
- a file edit as a diff;
- a fact from memory in gold, beside the turn that used it;
- the logo of the provider that wrote each reply (Claude, Codex, Grok or OpenRouter), so a
  session that moved between them shows who said what.

A session you run in a terminal is read from its transcript, and Chat adds each turn when the
turn completes, not word by word.

## Type into a session

1. Type in the box at the bottom. Enter sends, Shift+Enter makes a new line.
2. `@` opens a small menu of files in the session's folder, people and agents, and, as the first
   word of a message, your signed-in AI accounts. `@codex fix the failing test` sends that one
   message to Codex and leaves the session on its own provider (see
   [one message on another provider](sessions.md#one-message-on-another-provider)).
3. Anything starting with `/` goes to Claude Code as is, so its own commands (`/rename`, for
   example) work. A line starting with `!` runs as a shell command in the session's folder.
4. Paste an image to send it with the words (up to 5 pictures of 5 MB each: png, jpeg, gif or webp).

One surface holds a session's keyboard at a time (its lease). If another surface holds it, press
**Take over**. What you send shows as yours, and the session's replies as claude's (or the agent's name).

On a phone, Enter makes a new line and the send button sends.

**While a session works.** On a Claude session, a message you send joins the running turn at its
next step (steering). Press Alt+Enter, or turn on "Queue for after this turn", to hold it until
the turn ends. Held messages show above the box as **Queued messages**. A session that is busy in your terminal queues every message,
and sends it when that turn ends.

**Who answers.** **Switch model** (the model chip above the box) chooses another account or a
model. You cannot switch while a turn is running: press Escape first, or wait. [Sessions](sessions.md#one-picker-per-session) has the rest.

Typing into a session you started in a terminal makes Vyre resume it from then on.

> [!SNAG] "This session is open somewhere else"
> Only one process may write a session's transcript. Vyre refuses while the session is still
> open in a terminal (or wrote to its transcript in the last 30 seconds). Close it there, or type
> there.

> [!SNAG] "... ran in <folder>, which is not here"
> The session's folder does not exist on the machine serving the Vyre app, so it cannot be resumed
> there. Type into it on the machine where it ran.

## Reply to a message

Swipe a message on a phone, or long-press it anywhere, and choose **Reply**. The reply stays in the same timeline and carries a small quote of the message it answers: who said it and its first words (up to 140 characters). Tap the quote to jump to the original, which lights up for a moment. A reply never makes a side thread.

**Highlight to assistant** is different: it pins a message, or the part of it you selected, above the composer as a quoted reference. Nothing is sent until you send your message.

## Answer a question inline

When the session needs your approval, a card appears in the conversation with a **Needs you**
chip. Choose its approve button or **Decline**. The card shows the answer once it is answered,
from here or from any other surface.

## Open a terminal on the box

Open a chat's **About this chat** sheet and choose **Open full terminal**. A shell opens in that
chat's folder on the box, in the Vyre app. It asks for no passkey: it is your own screen.
Agents, guests and Claude's sessions can't open one.

A terminal belongs to the screen that opened it; another device can't pick it up. It outlives
your connection:

- Close the tab or lose the network, and the shell keeps running. Come back and the Vyre app picks
  up where it left off, with its own scrollback: the server sends only what this screen missed.
  It keeps the newest 1 MB of output; if more than that went by while you were away, a dim line
  says how much output was not kept, and the rest follows.
- Keys you type while the link is down are held, up to 4 KB, and sent once the terminal has
  caught up. The screen dims until then. Past 4 KB it says which keys were not kept.
- With nobody looking at it, it is kept for 12 hours, then ended. Change that with the config
  key `term.keep_hours`.
- On a server, the shell survives Vyre restarting, and the screen reattaches at once. Updating
  the server ends it: the terminal says "The server was updated and this terminal was closed." with a
  button, **Open a new terminal here**, for a new one in the same folder.
- Typing `exit` ends it at once.

On a phone, a key bar under the terminal gives Esc, Tab, Ctrl, the arrows, | and /.

On a Mac, the terminal ends when Vyre stops.

## Files in a chat

Open the chat's tools and choose Files. The panel lists what the chat made and what it received, each by name, with its size. A file shows a mark when it is shared with the chat's project.

Select a file to see it: text and images show right there, anything else says so. Share to project opens that one file to the project's members and nothing else in the chat. Unshare takes it back at once. File names are encrypted to the people in the chat, so only they see this list. See [Private chats](private-chats.md).

## Add files to a message

Tap the plus in the box and choose Attach a file or Attach a photo, or drop a file or paste a screenshot onto the chat in a browser. Each file is added to the chat's own folder at once, sealed like every chat file, and shows as a chip above the box; tap a chip to take it off. Send the message and the assistants get the files: an image comes with your words, and any other file (a PDF, a spreadsheet, a document) is put in the assistant's folder, where it reads it with its own tools. You can add up to five files a message: an image up to 5 MB, anything else up to 8 MB, 20 MB together. The chat keeps your words and the file names; the files are in the chat's Files panel.

## Put a file back

After a turn that edited files, the line under it ("2 files, 1 min") opens the changes. Each file there has Undo: it puts that one file back as it was before the turn. Undo only works while the file still holds what the turn left, so your own later edits are never overwritten; if the file changed since, nothing is touched and it says so. A file the session created is removed again. The session is told on its next message, so it does not build on what you took out. Vyre keeps the earlier versions until it restarts, and only for files inside the session's folder.

## Turn what it did into a Flow

When a turn used two or more of Vyre's own tools (it wrote records, made tasks, sent mail), the line under it says so ("3 actions") and has a button, Turn this into a Flow. It asks the assistant to make a draft Flow from the calls it just made and to say what is left for you to fill in. The draft is an ordinary one: you read it, test it and approve it before it can run.

## Records you name

When your message names a client, matter or other record exactly, such as "What case type is Dana Whitfield's matter?", the session is shown a short card of that record beside your words, so it need not stop to look it up. The card has the key fields and nothing sealed: a sealed field appears only as a placeholder the session can use in an action but never read. It only appears when the name is the record's whole title and no other record has it, and it is not repeated for the same record for twenty messages. The session can still look up anything the card leaves out. You can turn cards off in Settings (Cards for records you name).

## Sessions from your Mac

With a Mac paired, the server's Chat lists the Mac's sessions and projects beside its own, newest
first
([ADR 0021](../adr/0021-box-reads-the-mac.md)). Open one and its turns load from the Mac; the
server keeps no copy.

A message you type into a Mac session goes to the Mac, and the Mac holds that session's keyboard. If the Mac does not answer, the message
is not sent. If it times out, the message may have gone through, so check before you send again.

When the Mac cannot be reached, Chat lists only the server's sessions.

## When the box is out of reach

The status line says "Offline, showing what was saved" and Chat shows what it saved on your last
visit. A session you opened before may also open from the app's offline cache.

## What it will not do

- It is not a separate chat server. Everything is a call to Vyre, so a message typed here is the
  same as one typed in Lumen or with `vyre threads send`.
- It never renders a session's text as HTML.
- It does not move a session on your paired Mac to another provider. The picker is for sessions
  the server runs.

## Next

- [Projects and threads](projects-and-threads.md), how sessions are grouped.
- [Agents](agents.md), who runs the sessions.
- [CLI](cli.md#drive-a-running-session), to do the same from a terminal.
