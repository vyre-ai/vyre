---
title: Vyre Computer
summary: Let an agent work on a computer by name, the cloud computer by default or one of your Macs, with a Connection or a learned operation tried before the screen and a login typed in by the Vault.
audience: users, builders
owner: connectors
status: draft
---

# Vyre Computer

Vyre Computer is the name for everything that lets an agent work on a computer: the browser and
desktop on the cloud computer your agent keeps on the box, Chrome and apps on your own Mac, and the
screen you watch it on. You use it through one tool, `computer.use`.

## Which computer

Work goes to the cloud computer unless you name another one. Say it the way you would to a person:
"on my Mac", "on the office computer". If the name fits two computers, or none, the agent asks which
one, with the real names as choices and room to type or speak your own. It never guesses.

`computer.targets` lists the computers you can name and whether each is online.

## Interface first, screen last

Before an agent clicks around a page, Vyre looks for a better way: a Connection you made (a Slack
Connection for "send this on Slack"), or an operation Vyre learned from that site. If one covers the
site, the first screen action is not done. The agent is told what exists and why, and can use it, or
repeat the call to go ahead on the screen. Say "do it on screen" and Vyre goes straight to the screen.

## Your Mac

A box agent works on your Mac only for the kinds of work you allowed there. On the Mac:

```
vyre call link.computer.allow '{"class":"look"}'
```

The classes are `look` (read pages and apps), `act` (open, click, type, fill) and `files` (find and
bring files). Each is off until you turn it on, and `link.computer.revoke` takes it back at once.
Whatever an agent does on your Mac still goes through the same floor, indicator and stop key as
your own session, and a send it makes is held for your yes.

### Files

With `files` allowed, an agent can find files in your Downloads, Desktop and Documents and bring one
to the box (up to 8 MB, in parts). Nothing else on the Mac is reachable this way: not other folders,
not dotfiles, not a link that leads out. The file lands in the agent's inbox on the box. Sending it
anywhere (a Slack upload, an email) is a separate step, held for your yes.

## Logging in

Tag a login in your message with `#` (for example `#Northwind-Admin`) and the agent may use that login
in this conversation, on the sites it is for. The agent says `computer.use { do: "signin", login }`
and the Vault types the username, password and one-time code into the page on the agent's computer.
The agent never sees any of them. The tag ends with the conversation, after eight hours without use,
or when you take it back (`vault.untag`; `vault.tagged` lists where a login is lent).

A login can also be lent for a longer time with `vault.agent.grant`. If a site asks for a code the Vault
cannot make, the agent stops and asks you, and you type it yourself on the live screen.
