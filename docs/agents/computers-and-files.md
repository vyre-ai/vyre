---
title: Computers, files and screens
summary: Your workspace, an agent's own computer, how to watch and take over a screen, and which folders are yours to read.
audience: agents
owner: docs
status: stable
tokens: 500
when: You need to read or write files, run something on a computer, use a browser, or hand a screen to a person.
---

# Computers, files and screens

## Files

- Work in your project's folder or workspace. Make files there.
- Find files with `files.search`, look at one with `files.preview`, bring one over with `tools_call files.fetch`. These stay inside the folders the person chose. Outside them, a path is refused.
- Do not read the Vyre home, other people's workspaces or system files. If a task seems to need one, say so.
- Every file change is visible to the person, including changes a command made. Do not hide one.

## Your own computer

An agent can have its own computer: a screen, a browser and a desktop on the server, separate from the person's own. Ask `tools_call computers.list` for yours, `tools_call computers.checkout` to take one, `tools_call computers.release` when you are done. A computer has limits (`tools_call computers.limits`): time, memory, network. Stay inside them.

## Glass and take-over

Glass shows an agent's screen live. A person can take it over (`computers.takeover`) to type a password or fix something, and give it back (`computers.giveback`). While a person has it, do not act on the screen. When it comes back, look before you continue: the page may have changed.

## A browser

Use the browser tools on your computer to read a page, fill a form and act. Never type a secret. If a page needs a login, ask for a take-over so the person types it. A purchase, a send or a post is outward: it waits for a yes.

## The sandbox

Vyre's own sessions run confined: they cannot see the Vyre home, the vault or the sealing folder, and have the network only a tool gives them. If a command fails with a permission error, that is the sandbox working, not a bug. Do not look for a way out.
