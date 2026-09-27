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
   - *Files on demand*: this is what VyreDrive already does — a mounted share, fetched on open,
     nothing downloaded up front. **Built.** Recommend as the default; it's honest because it's
     the only mode that costs nothing extra.
   - *Keep a copy on this device*: not built. Needs real local caching/pinning, not just a mount.
     **L.**
   - *Server only*: today this is just "don't mount this share here" — an access choice per
     device, not a sync mode. **Built** as a checkbox, not as a labeled "mode."

3. **Where it shows up.** Finder sidebar on the Mac: **built** (`files.drive.mount`). Windows
   network drive: **not built** — no Windows client exists at all yet (session import's device
   role is the first Windows-facing work, and it doesn't touch Drive). Capsule drop target:
   **not built** — files.deliver (box→Mac) exists as a tool, no Capsule UI calls it. Phone:
   **not built**.

4. **Per-folder access (Capsule, chat, agents, per project).** Not built. Vault's grant pattern
   (per-secret, per-caller) exists and is the right shape to extend, but Drive shares have no
   grant table today — a share is visible to whoever can reach the mount, full stop. Agents get
   none by default is also not enforced (no agent has a Drive-aware tool at all right now, so
   this is moot until one exists — cheap to get right, list it as a gate, not a feature). **M.**

5. **Receiving files from the server (files.receive).** **Built** this session (0.1.1, e2e review
   of aa9cb40c/9338a6a5): off by default, per device, in config today — not yet a declared
   settings-hub entry (tried; a device-level setting needs a different store than config.json,
   reverted rather than ship unreviewed — see docs/work/federation.md). Offering it as a clear
   toggle in this step is **S**: wire the existing tool to a UI checkbox.

6. **Conflicts.** Partially built: Taildrop already renames on a name clash
   (`--conflict=rename`, core/files/drop.js) rather than overwriting — so the underlying transport
   already never silently overwrites. What's missing is telling the person: no visible note, no
   "keep both" framing anywhere. **S**: surface the rename as a notice; **M** if "keep both, ask
   which to trust" needs its own UI beyond a note.

7. **The moment that makes it stick.** Not built — needs the phone app and the Capsule drop
   target (3, above) both live before "drag a file in, see it on your phone in seconds" is real.
   Ordering: this is the payoff, not a separate build; it falls out once 3's gaps close. Track as
   part of 3's size, not its own line.

8. **Size and quota shown up front.** Sizes: not built into the picker (1) yet, but the numbers
   exist (drive.js already scans and could total a folder's size before sharing). Per-device quota:
   the sync.upload path has one (`sync_peers.quota_bytes`, no UI); Drive shares have none. Both
   need the user's call on the actual number — flagged, not decided here, per the lead's note.

## What's real right now, plainly

Drive today is a person naming a folder to share, mounted read-only or read-write on the Mac,
scanned once for secrets before it's allowed. Nothing is a "mode" yet in the sense this step
implies (on-demand vs. offline vs. server-only) — on-demand is just what mounting already is.
Framing it as a choice is fine (it reads well and sets the right default), as long as the other
two options are honestly labeled "coming" rather than implied to work today.
