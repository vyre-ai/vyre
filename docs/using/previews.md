---
title: Previews and questions
summary: How an agent shows you something it built or started as a card in the chat, how long it lives, who can open it, what a page may ask for, and how an agent asks you several things at once.
audience: users, agents
owner: docs
status: draft
---

# Previews and questions

A preview is something an agent built or started that you can open and use: a web page, a small app, a built site, a Markdown, SVG or Mermaid file. The agent calls `previews.open` and a card appears in the chat. You open it from the card, on its own address, and you can share it the way you share a document.

## Opening one

An agent gives a title and one of:

- `port`: a server it already started on your box. Vyre adopts it. The card says "Ends with this chat" until you choose Keep it running.
- `path`: a file or folder it wrote, inside the folder its session works in. Vyre serves the files itself, no process needed.
- `command` with `cwd`: only a person starts a command. An agent starts its server itself and gives the port.

Vyre's own ports are refused. The card shows one word for the state (Starting, Live, Stopped, Needs attention), and the verbs that fit: Open, Restart, Keep it running, Log, Stop.

## Who can open it

A preview is private to you by default, or to the project when it was made for one. Share changes it to the project or to everyone in the Space. Nothing leaves your Space from here: a public link is Publish, and it waits for your yes.

## What a page may ask for

A page can declare what it wants, in the call (`capabilities`) or in `.vyre/preview.json` beside it, the way a Claude artifact does: `db` (documents the page saves, kept in your records), `user` (who is viewing), `sample` (a model call) and `downloads`. Nothing is on by default, and the viewer allows each one.

## React pages

A page written in React runs on libraries the box ships, pinned and hashed, with no network fetch: React 18, Recharts, Lucide, D3, Lodash, PapaParse, mathjs, three.js, Chart.js, date-fns, SheetJS (spreadsheets) and Tailwind's in-browser build. An import outside that set gets a plain message on the page.

## A computer's live screen

When an agent works on a computer for you, `previews.operator` puts the screen on a card with what it is doing now, and `previews.step` updates the line. When it needs you to sign in, `previews.signin` puts a card that opens the screen with the keyboard yours and private: the agent never sees the password. When it is stuck and needs a code, the card has a box for it.

## Asking several things at once

`ask.many` shows one card with up to six questions, each with choices and room to type or say your own. You answer once and the agent hears the answers. The answers decide nothing by themselves: when the agent then sends or changes something, that still waits for your yes.
