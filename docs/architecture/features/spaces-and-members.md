---
title: Spaces and members
summary: How a Space, its people, its roles, its invites and each person's seat on a project are kept and checked.
audience: builders, agents
owner: docs
status: stable
---

# Spaces and members

## What it is

A Space is one kernel with its own people, roles, grants and records. The `spaces` module (`core/spaces/`) adds the person-facing calls: make a Space, list its members, change a role, send an invite. The `roles` module adds custom roles, and the `work` module keeps each person's seat on each project.

## What a person sees

- Settings, Spaces and members (screen title "Spaces and members", sub line "Where your things live, and who is in them."). The button **Add a space** offers **Create a space** and **Join a space**.
- Each Space row shows its address and a line "`<Role>`, lives on `<home>`".
- Under "Members of `<space>`": each member with a role, **Extend** for a guest, **Invite someone** and **Add a guest**. A role sheet has **Save** and a held **Remove** button; a guest sheet asks for "Their Vyre name", "Only this project" and "Ends".
- Settings, Roles (screen title "Roles"): a "Built in" group (Owner, Admin, Member, Guest) and "Your roles" with **New role**. A role page has four parts: "1. Can do", "2. Where", "3. Which data", "4. Which tools". Only an owner or admin sees it.
- The invite role picker is in `apps/app/screens/roles/InviteRolePicker.tsx`. A project seat is chosen as Lead, Contributor or Viewer; Contributor is the default.

## How it works

**Roles.** The kernel knows five role ids, `owner`, `admin`, `manager`, `member`, `temp` (`kernel/contracts/index.js`, `ROLE_IDS`). The app shows four: Owner, Admin, Member and Guest, where Guest is `temp` (`lib/roles/catalogue.js`, `BUILTIN_VIEW`). Each role expands to named grants with source `role:<id>` (`kernel/grants/roles.js`, `ROLE_ACTIONS`). Wildcards never cover admin, grant or outward actions. A `temp` member holds only records.read, `records.create`, `records.update`, tasks.read and tasks.work, needs a non-empty scope and a future end date (`lib/spaces/members.js`).

**Who may set whom.** `ROLE_MAY_SET`: an owner sets any role; an admin sets manager, member and temp; nobody else sets any. A Space always keeps at least one owner (error code `last_owner`). Granting owner, handing ownership over and extending a guest need a presence proof (`needs_presence`).

**Custom roles.** A custom role is a `def-role` record (`lib/roles/store.js`), built from Member or Admin. It expands to ordinary grants, and `kernel/grants` refuses anything outside the base role. An admin never makes or gives a role at or above admin (`core/roles/index.js`).

**Member reach.** A member reaches a project only through the project.reach action, held by role for people and by a grant of its own for an agent (`kernel/grants/index.js`). `projectOracle` (`kernel/gateway/project-members.js`) reads the Project record and its `team-member` rows: a person is a member when they own the project or have a person row. A teammate agent opens the project's files only while a task of its own there is ready or working. A custom record type is readable by every member today (see Limits).

**Seats and levels.** A `team-member` row carries `level`: `lead`, `contributor` or `viewer`; a row with none is a contributor (`lib/seat-levels.js`). A level only narrows the Space role. A viewer writes nothing in the project, and their AI session there is read only. A lead manages the project's team only when the Space role is member or above. `work.project.level` sets a level: only the project's owner or a lead, or a Space owner or admin may, and a person not yet on the project is seated at that level.

**Invites.** `spaces.invites.create` makes a signed join link (`lib/spaces/invites.js`): a payload of `id`, `space`, `role`, `scope`, `expires`, `uses`, signed with the Space's root key and checked against the pinned key by `spaces.invites.preview`. Defaults: 7 day life, at most 30 days, at most 100 uses. The input `seats` lists `{ project, level }`. On accept, the `work` module hears invite.used and seats the joiner on each named project through `setSeatLevel`; a replay leaves an edited seat alone (`core/work/invite-seats.test.js`).

**Kernel checks.** Each tool in `core/spaces/module.json` declares a reach. `person` tools run under the caller's own chain (a person, not a model). `modules` tools are for other modules. `spaces.invites.redeem` and `spaces.code.submit` are open to anyone, because the caller is not a member yet. Role changes go to the kernel (`grants.role`, `grants.member`, `grants.invite`), which decides again. A refused act reads like absence (`not_found`) and writes `access.denied`.

**Data.** SQLite tables `spaces_space`, `spaces_member`, `spaces_member_person`, `spaces_invite`, `spaces_invite_space`, `spaces_role_name`, `spaces_pairing`, `spaces_kv` (`core/spaces/store.js`). The kernel's own membership and grants are the source of truth for a server-hosted Space (`core/spaces/kernel-members.js`).

**Events.** `member.added`, `member.role-changed`, `member.removed`, `member.extended`, `member.expired`, `ownership.transferred`, `invite.created`, `invite.accepted`, `invite.revoked`, `invite.expired`, `space.create-done`.

## Where the code lives

- `core/spaces/`: the module, tool wiring, kernel member calls, storage.
- `lib/spaces/`: members, invites, homes, upgrade and move rules, kept pure.
- `core/roles/`, `lib/roles/`: custom roles and the role catalogue.
- `kernel/grants/roles.js`: the role-to-actions table.
- `kernel/contracts/index.js`: role ids, rank, who may set whom.
- `kernel/gateway/project-members.js`: who is on a project.
- `lib/seat-levels.js`: Lead, Contributor, Viewer.
- `core/work/`: seats on projects (`work.project.level`, `work.project.members`).
- `apps/app/screens/spaces/`, `apps/app/screens/roles/`: the screens.

## How agents use it

- Open to a model with a person's rules: reads such as `spaces.members.list`, `spaces.invites.list`, `roles.list`. Check the reach in `docs/reference/tools.md` before calling.
- Person only (proof or the person's own chain): `spaces.members.add`, `spaces.members.set-role`, `spaces.members.remove`, `spaces.members.transfer`, `spaces.invites.create`, `spaces.invites.confirm`, `roles.create`, `roles.assign`. The app holds role changes and invites for a yes (`apps/app/src/real/approvals.js`).
- `spaces.members.add-agent` adds an agent as a Space actor, owners and admins only, under the person's proof.
- `work.project.members` lists a project's team and levels for a caller who may read the project.
- See authority (agent doc "authority") and tools (agent doc "tools").

## Limits today

- A member can read every row of a record type the Space defined itself, even when the row is linked to a project the member is not on. Per-record privacy is planned for 0.5.1.
- A Viewer's AI can read a project's records and files through Vyre, but cannot open the project's folder directly.
- Renaming a project on a team server changes the short name that keys its folder group; the next session there is refused until a re-key step exists.
- A member cannot add a setup token or API key as their own AI account, and sessions do not read other items in a member's own vault yet.

## Related

- [Identity and devices](./identity-and-devices.md), [Kernel](./kernel.md), [Gate](./gate.md), [Vault](./vault.md), [Agents](./agents.md)
- [Architecture map](../map.md), [Overview](../overview.md)
- [Spaces](../../using/spaces.md), [Projects and threads](../../using/projects-and-threads.md), [Your private network](../../concepts/network.md), [Tools reference](../../reference/tools.md)
