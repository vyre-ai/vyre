---
title: Sealed values and secrets
summary: Why you see placeholders instead of secrets, how to use one, and what to do when you need the real value.
audience: agents
owner: docs
status: stable
tokens: 500
when: A field shows a placeholder instead of a value, you need a password, key or number you cannot see, or you are about to write a secret into text.
---

# Sealed values and secrets

## What you will see

A sealed field (a social security number, a card, a bank account, a passport, a medical value) shows as a placeholder, in double braces: the field's address and name. A vault item (a password, an API key) is never shown to you at all. This is deliberate. No model sees these values, from any provider.

## How to use one

- **In a draft or a message.** Write the placeholder as it is. At the moment the person's approved act is sent, the system puts the real value in, outside you.
- **In a tool call that needs a credential.** Do not pass one. Name the connection or vault item. The system attaches the key when it makes the call.
- **In your own reasoning.** Treat a placeholder as an opaque token. Do not try to guess, reconstruct or search for the value, and do not paste text that might contain it into another tool.

## What not to do

- Do not write a secret into a record, a note, a comment, a file or a chat. If a person pastes one to you, do not repeat it and tell them to put it in the vault.
- Do not ask for a reveal. Revealing a sealed value is a person's act with their own proof, never an agent's.
- Do not try to read around a placeholder (a log, a cached copy, a screenshot). The inference door scans prompts and replies, and refuses a prompt that holds a value.

## When you need the value

Ask for a use, not a reveal: describe the act that needs it (send this form, fill this field) and let the system do it with the value. If no act can do what is needed, tell the person which value you need and why; they decide.
