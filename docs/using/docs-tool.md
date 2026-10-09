---
title: Ask the docs from inside Vyre
summary: Find and read the docs pages without leaving Vyre: docs.find takes what you want to do in plain words, docs.read returns a page or one section of it.
audience: users, builders
owner: docs
status: stable
---

# Ask the docs from inside Vyre

The docs you are reading are also a tool. `docs.find` takes what you want to do, in plain words, and returns the best pages. `docs.read` returns a page, or one section of it.

```sh
vyre call docs.find '{"query":"how do I back up the server"}'
```

Each result has the page, its title, what it is for and what reading it costs, in tokens. Read one:

```sh
vyre call docs.read '{"page":"using/box-care.md"}'
```

## Read one section

A long page comes back as its outline and the first sections that fit. Ask for exactly what you need with a heading, and you read, and pay for, only that part:

```sh
vyre call docs.read '{"page":"using/box-care.md","heading":"back-up"}'
```

## Who sees what

You see the published docs, the ones on the website. A session or an agent that works for you in Vyre also reads a second set written for agents: how Vyre decides what an agent may do, how outward acts are held, how to find a tool. That set is not shown to people and is not on the website, but it is not secret: the code is open source.

For the way Vyre is built, start with [The Vyre map](../architecture/map.md).
