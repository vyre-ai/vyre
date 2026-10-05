---
title: Private chats
summary: Each chat and its files are encrypted to the people in that chat; what the server, its owner and its admins can and cannot read.
audience: users
owner: docs
status: draft
---

# Private chats

Each chat and its files are encrypted to the people in that chat. A space's owners and admins cannot read chats they are not in, even with access to the server's disk. File names are encrypted too.

## How it works

- **A key for each chat.** A chat has its own key. The key is wrapped to the keys of the devices that belong to the people in the chat, so only those devices can open it.
- **A key for each file.** Every file in a chat has a key of its own, sealed under the chat's key. The name of the file is sealed as well; the server sees a stable id, not the name.
- **No key is written to the server's disk.** It stores documents and ciphertext. Keys live on your devices and, while an agent you allowed is working, in the running program's memory only. A chat started on the server gets its key from the server's own running process, which wraps it to each person's device and keeps it in memory only. Keys are never written out, and they are wiped when you lock.
- **Owners and admins are not special.** The owner, an admin and a member of the project who are not in the chat are refused when they try to read it, list it, change it or delete it, whether they ask through the server or look at its disk. The log keeps no file names.

## Changing who is in a chat

- **Adding someone** can include the history or start from now. Without history, they read only what is sent after they join.
- **Removing someone** rotates the key. The removed person cannot read anything sealed after that.

## Sharing a file to a project

Sharing a file to a project is a grant for that one file, not a copy: the file's key is wrapped to the project's key. A project member who is not in the chat can open that file and nothing else in the chat. Unsharing takes the grant back at once and rotates the file's key.

## What it does not hide

While an agent works in a chat on a server, that server's operator could see that chat in use. To avoid that, run the agent on your own computer or your own server. See [Your private network](../concepts/network.md) for how devices reach each other.

## Next

- [Chat](chat.md): reading and writing in a chat.
- [Spaces](spaces.md): Personal, My Cloud and Cloud.
