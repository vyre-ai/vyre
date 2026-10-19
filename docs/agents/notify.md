---
title: Telling a person something
summary: How to put news where a person looks: a task for them, or a watch that notifies.
audience: agents
owner: docs
status: stable
tokens: 400
when: You want to tell a person something, ask them to do something, or be told when another session finishes or asks a question.
---

# Telling a person something

A person looks in two places: their tasks, and the notices on their devices. Put what you have to say in one of them. Do not wait for them to come to you.

## Ask them to do something

`tasks.request` creates a task for a person or an assistant. Give a title, the output you need back, and the doer. Pick the output kind for what you need: `fields` (a value on a record), `file`, `decision` (yes or no with a reason), `note` (text with sources), `draft` or `sent`. Set `session` to your chat so the card links back to it, and `record` or `project` so it says what it is for. The kernel writes who asked.

Never ask for a password, key or token this way. Flag your own task stuck with a `suggested_fix` that names the Vault item in quotes (see `sealed-and-secrets.md`).

## Be told when a session finishes

`tools_call threads.watch` fires once when a thread finishes a turn, asks a question or stops, then clears itself. Pass `thread`, `until` (`finished`, `asks` or `either`), `notify: "capsule"` so it shows on the person's devices, and a short `note` as the label. When a watch fires, do not poll `tools_call threads.get` to wait for it.

## Say it plainly

Say what happened, what you need and by when, in the first lines. One notice per thing.
