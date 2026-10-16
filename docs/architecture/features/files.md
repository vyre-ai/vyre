---
title: Files
summary: The Space's Drive with versions, links you share, and folders linked live from Google Drive or Dropbox, plus the box and computer folders an agent may search.
audience: builders, agents
owner: docs
status: stable
---

# Files

## What it is
Files is the Space's Drive plus two other ways to reach files: shared links to one version of a file, and folders linked live from another service. Mounted files, a folder of the box shown on a computer, are coming later.
Every file has a fixed place under the files root, named by ids that never change (lib/files/layout.js).

## What a person sees
The Files screen has three tabs (apps/app/screens/drive/tabs.js): **Space**, **Shared** and **Linked**.
- **Space**: the Drive, a file's versions with **Put back** (restore as a new version), and **Share a link**.
- **Shared**: links the person made, each with **Copy** and **Stop**. The empty state reads "No shared links. Open a file and choose Share a link. You say yes before anything is made."
- **Linked**: **Link a folder**, a picker that walks the source one level at a time, a **Name in Files** field ("It appears at Linked/<name>"), then **Sync**, **Sync now**, **Edit** for text files and **Unlink**. "You see inside it only what your own account allows."
- A phone and a computer can send each other a file, and the receiver gets it when it next connects.

## How it works
**Layout.** `Projects/<project id>/files`, `chat/<chat id>`, `made/<chat id>`, `agents/<agent id>/instructions|context|memory|work`, `objects/<object>/<record id>/` for a record's attachments, `templates/<id>/`, `flows/<id>/`, a `space` folder for the Space's own documents, and `Linked/<link name>/`. A rename changes the display name and moves nothing. `whereIs(path)` reads a path back. See [files-layout](../../reference/files-layout.md).

**The Space's Drive** (core/files/space-drive.js) calls the kernel's Drive under the caller's own chain: `files.drive.upload` (a new version, at most 8 MB, with a `base` version so a second writer is told), `files.drive.versions`, `files.drive.restore` (a new version, the person's own act with presence), `files.drive.space.list`, `files.drive.space.read`. The kernel's drive.read, drive.write and drive.restore grants decide. A Space with no Drive answers `unavailable`.

**Shared links** (core/files/space-links.js). `files.drive.link.create` makes a read-only copy of one version under a random code, for 1 to 30 days (default 7), served at `/v1/files/s?c=<code>`. The copy never touches the live file or anyone's grants. Making one is outward: a held ask for an assistant, a call with presence for a person. `files.drive.link.list` and `files.drive.link.revoke` (deletes the copy). A wrong, expired or revoked code looks the same.

**Linked folders** (core/files/linked.js). `files.linked.link` records a pointer `{ name, provider, source }` in table `files_linked`, and no bytes move. A provider is Google Drive (`linked-gdrive.js`, source `{ folder }`) or Dropbox (`linked-dropbox.js`, source `{ path }` or `{ id }`), both behind one interface (`linked-provider.js`). Every call is made as the calling person. Google answers through that person's own account. Dropbox answers through that person's own Vault item, with no fallback to another person's and no firm key (`dropbox-seam.js`). Two people therefore see two different listings of one link. Each (link, person) pair has its own search index (`files_linked_index`, text capped at 100,000 characters per file), and `files.linked.sync` updates only the caller's. A file's content is fetched when opened and never ahead. `files.linked.write`, `rename` and `delete` go to the source, and a stale `baseRev` is a `conflict` that writes nothing. A Dropbox delete moves the file to "Vyre Trash" inside the linked folder. Whoever linked a folder, or the Space owner, can unlink it, and unlinking never touches the source.

**Folders on the box and computer.** `files.search`, `files.stat`, `files.preview`, `files.fetch`, `files.dirs` and `files.recent` go through one guard (core/files/safety.js). The path must be absolute, inside a configured root, still inside after following symlinks, and outside Vyre's home, the vault, credential folders, dot-folders and any name that looks like a key. A refusal says only "not available". access.js decides which folders a named agent reaches: the assistant walks every mapped project, and any other agent only its granted projects. The box also offers named folders, shares (config `files.drive.shares`, plus the projects folder), which `files.drive.status` lists, `files.drive.search` searches by name or content, and `files.drive.list` and `files.drive.read` browse and read in chunks, under the same guard. A project's folder shows the media its agents made under a virtual Generated folder. Typing `#` in a chat finds a file by name in a share (`files.mentions.search`) and lets that chat read that one file.

**Sending.** `files.send`, `files.receive` and `files.drop.*` hand a file to another device, sealed to the receiver's key. The home keeps only ciphertext, for a bounded time (drop-store.js). Events: `files.sent`, `files.received`.

## Where the code lives
- `core/files/index.js` the module. `module.json` tools and events.
- `core/files/space-drive.js`, `space-links.js` Space Drive and shared links.
- `core/files/linked.js`, `linked-read.js`, `linked-index.js`, `linked-provider.js`, `linked-gdrive.js`, `linked-dropbox.js`, `dropbox-seam.js` linked folders.
- `core/files/safety.js`, `access.js`, `dirs.js` the guard, per-agent reach, box folders.
- `core/files/drive.js`, `browse.js`, `mentions.js` the box's shares: status, search, list, read, the `#` file tag and the Generated folder.
- `core/files/drop-*.js` device to device drops.
- `lib/files/layout.js` the one place that builds paths.
- `kernel/gateway/drive.js`, `kernel/gateway/shares.js` the kernel's Drive and chat file shares.
- `apps/app/screens/drive/` the Files screen. `apps/app/ui/files/` file viewers.

## How agents use it
Read tools are open to models as the person they work for: `files.drive.space.list`, `files.drive.space.read`, `files.drive.versions`, `files.linked.list`, `files.linked.ls`, `files.linked.read`, `files.linked.search`, `files.search`, `files.stat`, `files.preview`. Writes that leave or change a source (`files.drive.upload`, `files.drive.link.create`, `files.linked.write`, `files.linked.rename`, `files.linked.delete`, `files.linked.link`) belong to person callers, and several are declared outward, so they are held for a yes. `files.drive.restore` and `files.linked.unlink` need the person. See computers-and-files (agent doc "computers-and-files").

## Limits and extension points
- In 0.5, a Viewer's AI reads a project's records and files through Vyre and does not open the project's folder directly.
- A Google Doc, Sheet or Slides file in a linked folder is read as text and is not written back as bytes (core/files/linked-gdrive.js).
- Files that a shell command changes are not recorded, and the Gate does not watch shell file changes. Agents write through the `files.*` tools to get versions and holds.
- To link a source beyond Google Drive and Dropbox, such as a case-management system's document store, build a custom module. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related
- [records](./records.md), [documents-and-signing](./documents-and-signing.md), [vault](./vault.md), [gate](./gate.md), [relay-and-networking](./relay-and-networking.md), [sessions-and-models](./sessions-and-models.md)
- [map](../map.md), [overview](../overview.md)
- [files-layout](../../reference/files-layout.md), computers-and-files (agent doc "computers-and-files"), [vault](../../using/vault.md), [floor](../../concepts/floor.md)
