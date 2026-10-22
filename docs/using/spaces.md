---
title: Spaces
summary: Personal, My Cloud and a team's Cloud space. You work in one Space at a time. Sign in with the Space, your username and your password.
audience: users
owner: docs
status: draft
---

# Spaces

A space is where a set of people and their work live: chats, projects, records, files and the devices that reach them. You work in one Space at a time. The menu at the foot of the sidebar switches: it shows the Space address and your role. There are three kinds, and each has a name you see in the Vyre app.

| Name | Where it runs | What it is |
|---|---|---|
| **Personal** | On your devices | Your own space. It keeps your chats and projects on your devices. |
| **My Cloud** | On your own server | Your own space on a computer or a server that stays on. Your phones and browsers connect to it. It adds Records and Flows, reachable from anywhere. |
| **Cloud** | On a team's server | A team space. It runs on a server and is tagged **Cloud**, with the team's own name beside it (for example "Juniper Studio"). |

Your space list reads "Personal, Juniper Studio" before you have your own server, and "My Cloud, Juniper Studio" after.

## Personal

Personal needs no server. Chats and projects work as normal on your devices. Records, flows and Kits need a space that runs on a server, so on a Personal space with no server those places say "This needs a Cloud space" and offer **Set up My Cloud**, or the team spaces you are in.

If you are in a team's Cloud space, Personal also has reminders, notes, to-dos and the calendar: they are kept, encrypted, on that team's server, and they show on [Home](home.md). Open Settings and use **Where your personal items are kept** to pick the Cloud space; the line under the choice says how much room they use. Custom Records, Customize, flows and Kits stay on a server space either way.

Personal also shows where it is backed up: **Backed up, encrypted, to** the team's Cloud space, or **Not backed up: join a team or set up My Cloud**.

## My Cloud

When you set up Vyre, you sign in with the Space, your username and your password, or **Continue with GitHub**, then join a space or create one. **Create a space** sets up My Cloud on a Linux server or a computer that stays on: the app shows one install command with a single-use pair code built in, you run it on the server, and the server adopts you when it comes online. The app waits on that screen until it does. **Join a space** takes an invite link, `https://vyre.run/i/<token>`. A phone is sent a link and never an install command. The steps are in [Install](../get-started/install.md).

To make this computer the server, open Settings and choose to make it the server for My Cloud. It must stay on, and it runs Records for My Cloud. Records live in Vyre's own store.

If you joined a team first, **Add your own server** on that home takes you to the same setup.

## A team's Cloud space

**I am joining a team** needs only a name and a code: make your name, connect the device with the code a team member gives you, and you are in. Inside a space, what each person may do depends on their role: owner, admin, manager, member or temp. See [Your private network](../concepts/network.md#the-owner).

## Records and servers

Records (contacts, projects, tasks and anything you define) live in Vyre's own store on a space that runs on a server, My Cloud or a team's Cloud space. Flows and Kits live there too. A Personal space on a device never starts that store. One space per server. 8 GB of memory is recommended, and 4 GB is the least ([Install](../get-started/install.md)). `vyre status` prints `records: Vyre store` and the number of records.

## Next

- [Private chats](private-chats.md): who can read a chat.
- [Install](../get-started/install.md): setting up a server.
