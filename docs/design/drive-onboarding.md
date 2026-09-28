---
title: "Drive onboarding: what to sync, how, and the moment it sticks"
summary: Options for a new onboarding step covering VyreDrive, sized and marked built or not, for the lead to take to the user.
audience: builders
owner: federation
status: draft
---

# Drive onboarding

Options for the new step (between connecting accounts and the phone, per the lead). Each marked
built, S, M or L. Follows interaction.md section 3: reversible and cheap choices (turning a folder
on, the files.receive switch) are optimistic with Undo; sync.delete stays confirm-with-preview,
never Touch ID (it's not a secret action, ADR 0024).

1. **What to sync.** Not built. Today VyreDrive shares whole folders the person names by hand
   (`files.drive.share`); there's no picker showing Desktop/Documents/each project's files folder
   with sizes, no default exclusions the person can edit (drive.js's scan skips node_modules,
   .git, dist etc., but that list isn't user-facing or editable). **M**: a scan+picker UI plus an
   editable exclusion list (size and an over-N-MB filter).

2. **How.**
   - *Files on demand*: this is what VyreDrive already does: a mounted share, fetched on open,
     nothing downloaded up front. **Built.** Recommend as the default; it's honest because it's
     the only mode that costs nothing extra.
   - *Keep a copy on this device*: not built. Needs real local caching/pinning, not just a mount.
     **L.**
   - *Server only*: today this is just "don't mount this share here", an access choice per
     device, not a sync mode. **Built** as a checkbox, not as a labeled "mode."

3. **Where it shows up.** Finder sidebar on the Mac: **built** (`files.drive.mount`). Windows
   network drive: **not built**, no Windows client exists at all yet (session import's device
   role is the first Windows-facing work, and it doesn't touch Drive). Capsule drop target:
   **not built**, files.deliver (box→Mac) exists as a tool, no Capsule UI calls it. Phone:
   **not built**.

4. **Per-folder access (Capsule, chat, agents, per project).** Not built. Vault's grant pattern
   (per-secret, per-caller) exists and is the right shape to extend, but Drive shares have no
   grant table today: a share is visible to whoever can reach the mount, full stop. Agents get
   none by default is also not enforced (no agent has a Drive-aware tool at all right now, so
   this is moot until one exists, cheap to get right, list it as a gate, not a feature). **M.**

5. **Receiving files from the server (files.receive).** **Built** this session (0.1.1, e2e review
   of aa9cb40c/9338a6a5): off by default, per device, in config today, not yet a declared
   settings-hub entry (tried; a device-level setting needs a different store than config.json,
   reverted rather than ship unreviewed, see docs/work/federation.md). Offering it as a clear
   toggle in this step is **S**: wire the existing tool to a UI checkbox.

6. **Conflicts.** Partially built: Taildrop already renames on a name clash
   (`--conflict=rename`, core/files/drop.js) rather than overwriting, so the underlying transport
   already never silently overwrites. What's missing is telling the person: no visible note, no
   "keep both" framing anywhere. **S**: surface the rename as a notice; **M** if "keep both, ask
   which to trust" needs its own UI beyond a note.

7. **The moment that makes it stick.** Not built: needs the phone app and the Capsule drop
   target (3, above) both live before "drag a file in, see it on your phone in seconds" is real.
   Ordering: this is the payoff, not a separate build; it falls out once 3's gaps close. Track as
   part of 3's size, not its own line.

8. **Size and quota shown up front.** Sizes: not built into the picker (1) yet, but the numbers
   exist (drive.js already scans and could total a folder's size before sharing). Per-device quota:
   the sync.upload path has one (`sync_peers.quota_bytes`, no UI); Drive shares have none. Both
   need the user's call on the actual number, flagged, not decided here, per the lead's note.

## What's real right now, plainly

Drive today is a person naming a folder to share, mounted read-only or read-write on the Mac,
scanned once for secrets before it's allowed. Nothing is a "mode" yet in the sense this step
implies (on-demand vs. offline vs. server-only): on-demand is just what mounting already is.
Framing it as a choice is fine (it reads well and sets the right default), as long as the other
two options are honestly labeled "coming" rather than implied to work today.

## Step 3 design: per-folder access, a concrete shape (28 Sep 2026, federation)

Item 4 above named the direction. This is the concrete shape, for the lead and the reviewer to
read before any code lands.

### The grant

A new table, `sync_grants`, in core/sync's own migrations (not vault_grants itself: that table is
credential items and its own invariants, kinds, and audit path belong to the vault team; this
mirrors its exact shape instead of borrowing its rows):

```
CREATE TABLE sync_grants (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL,
  UNIQUE (project, agent)
)
```

Same fields as `vault_grants (item, module, watcher, status, by, at)`, renamed for this domain:
`project` (a project-id.js slug, `isProjectId` checked before it is ever stored) stands in for
`item`, `agent` (an agent's name, empty string for "every agent") stands in for `module`/`watcher`.
`status` is `"granted"` or `"revoked"` rather than deleting a row, so a later `sync_grants.list`
shows history the same way `vault.list` does for its own grants.

Why a project-id.js slug and not the sync.scan folder name directly: a project's synced folder
(the device's `projects/<name>` under its Claude Code folder) and a box-side project (`projects.*`,
teammates' agent naming, memory's rooms) are not guaranteed to be the same string today, and this
is the join point. Deciding that join is its own small piece of work (probably: the person's own
project picker at consent time offers box-side project ids to tag a device's folder with, not the
device's own raw folder name) and is out of this design; sync_grants stores whichever slug that
join lands on, and refuses anything that fails `isProjectId`.

### The default, and who may change it

No agent has a grant by default (deny by default, same as vault). `sync.grants.set { project,
agent, status }` is person-only (core/presence PERSON_ONLY, same reasoning as
`files.drive.access`: a switch on an existing capability, not a secret reveal, so PERSON_ONLY
rather than HUMAN_ONLY). An empty `agent` string is "every agent" (matching a bare module grant in
vault_grants); a named agent narrows it to that one, and the more specific row wins when both
exist, same precedence vault's own release path already resolves.

### What an agent sees when a folder is not granted

Two surfaces, both refuse the same way vault's `vault.release` does today (line ~1074,
`core/vault/vault.js`): a clear, actionable error naming the exact fix, never a silent empty
result and never a vague "denied":

- **A specific file or session.** Reading a file, or a session's content, inside an ungranted
  project throws `"<project>" is not granted to <agent>; call sync.grants.set to fix it` (the
  reviewer may want the exact wording tightened to the harness's own conventions before this
  ships; the point is the shape, not the string).
- **A list or search.** Recall search, `sync.scan`-style listings, anything that returns rows
  across several projects: an ungranted project's rows are left out of the result entirely, the
  same way `vault.list` never shows a value it did not grant. Nothing marks the gap (no "1 hidden
  project" placeholder): an agent that has never been told a project exists learns nothing new
  by its absence, which is the point of a project boundary in the first place.

### Open questions for the lead and the reviewer

1. Is `sync_grants` the right owner (core/sync), or should this live wherever `projects.*` lives
   today, since it is a project-level concept and sync is only the first caller of it? Building it
   in core/sync first and moving it if a second caller needs it seems cheaper than guessing now,
   but flagging it since it is the kind of thing that is annoying to move later.
2. The project-id join (device folder name to box project id) needs a decision before step 3's
   code, not just its design: does the person pick a box project for each device folder at
   `sync.consent` time (extending the picker this session's `sync.scan` already built), or is it
   inferred some other way?
3. `sync_grants` needs its own presence rule confirmed (PERSON_ONLY vs. HUMAN_ONLY) before it
   ships, the same review `files.receive` just went through, flagging now so it is not a second
   HOLD.
