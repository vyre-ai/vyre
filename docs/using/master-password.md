---
title: Master password
summary: One master password unlocks your username and your personal vault. A space vault keeps working for agents when you are away, and they still never see the value.
audience: users
owner: docs
status: draft
---

# Master password

You have one username and one master password. The username is your address, `https://vyre.run/u/alex` for example, and it is private unless you choose to be listed. The old address `alex.vyre.run` redirects there. Your master password unlocks your identity and your personal vault on this device. You enter it on your device. An agent never sees it, and it never sees your recovery key.

## The recovery key

When you create your username, or the first time this device wraps an existing identity, the Vyre app shows a recovery key on one screen. Save it. It is the way back in if you forget the master password. Anyone who has that key can unlock this device, so keep it where you keep a spare house key.

## GitHub

Login with GitHub links that GitHub account to your username. It signs you in. You still enter the master password to unlock the vault.

## Another computer

On the new computer, give the space server address, your username and your master password. Or sign in with the linked GitHub account and the same master password. Each space has its own server address. Your username is the same on all of them.

## Your vault, and a space vault

Your personal vault keeps working the way it does today. A module, a Flow or an agent uses an item by name. The value is placed into the request at that moment, and the caller gets the response, never the value. You do not have to be unlocked for that.

A space has a vault of its own, with no separate password. The space key is wrapped for each member, and the server holds a wrap too, so agents and Flows keep using those items when nobody is online. When a member leaves, the space key is rotated and their wrap is dropped. The lending rule is the same: the value goes into the call, and the agent receives the result.

## Handing a space on

The owner of a space can hand it to another member. That change is recorded. An agent can propose it. Your one tap is what applies it. The same is true of inviting someone, changing a role, adding a computer or a phone, and setting up the space vault. You enter the master password and any vault value yourself.
