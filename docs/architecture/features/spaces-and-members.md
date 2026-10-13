---
title: Spaces and members
summary: How a Space, its people, its roles, its invites and each person's seat on a project are kept and checked.
audience: builders, agents
owner: docs
status: stable
---

# Spaces and members

## What it is

A Space is one kernel with its own people, roles, grants and records. The `spaces` module (`core/spaces/`) adds the calls a person uses: make a Space, list its members, change a role, send an invite. The `roles` module adds custom roles. The `work` module keeps each person's seat on each project.

## What a person sees

- Settings, Spaces and members (sub line "Where your things live, and who is in them."). The button **Add a space** offers **Create a space** and **Join a space**.
- Each Space row shows its address and a line "`<Role>`, lives on `<home>`".
- Under "Members of `<space>`" each member appears with a role. **Extend** renews a guest. **Invite someone** and **Add a guest** add people. A role sheet has **Save** and a held **Remove** button. A guest sheet asks for "Their Vyre name", "Only this project" and "Ends".
- Settings, Roles shows a "Built in" group (Owner, Admin, Member, Guest) and "Your roles" with **New role**. A role page has four parts: "1. Can do", "2. Where", "3. Which data", "4. Which tools". Only an owner or admin sees it.
- The invite role picker is `apps/app/screens/roles/InviteRolePicker.tsx`. A project seat is Lead, Contributor or Viewer, and Contributor is the default.

## How it works

**Roles.** The kernel knows five role ids: owner, admin, manager, member and temp (`kernel/contracts/index.js`, `ROLE_IDS`). The app shows four. Guest is temp (`lib/roles/catalogue.js`, `BUILTIN_VIEW`). Each role expands to named grants with source `role:<id>` (`kernel/grants/roles.js`, `ROLE_ACTIONS`). A wildcard never covers admin, grant or outward actions. A temp member holds only records.read, records.create, records.update, tasks.read and tasks.work. A temp member also needs a non-empty scope and a future end date (`lib/spaces/members.js`).

**Who may set whom.** `ROLE_MAY_SET` says an owner sets any role, an admin sets manager, member and temp, and nobody else sets any. A Space keeps at least one owner (error code `last_owner`). Granting owner, handing ownership over and extending a guest each need a presence proof (`needs_presence`).

**Custom roles.** A custom role is a `def-role` record (`lib/roles/store.js`) built from Member or Admin. It expands to ordinary grants, and `kernel/grants` refuses anything outside the base role. An admin cannot make or give a role at or above admin (`core/roles/index.js`).

**Member reach.** A member reaches a project through the project.reach action. A role carries it for people, and a grant of its own carries it for an agent (`kernel/grants/index.js`). `projectOracle` (`kernel/gateway/project-members.js`) reads the Project record and its `team-member` rows. A person is a member when they own the project or have a person row. A teammate agent opens the project's files only while one of its own tasks there is ready or working. In 0.5 every member can read a custom record type, as the Extend it section describes.

**Seats and levels.** A `team-member` row carries `level`: lead, contributor or viewer. A row with none counts as contributor (`lib/seat-levels.js`). A level narrows the Space role and never widens it. A viewer writes nothing in the project, and their AI session there is read only. A lead manages the project's team when the Space role is member or above. `work.project.level` sets a level. Only the project's owner, a lead, or a Space owner or admin may call it, and it seats a person who is not yet on the project at that level.

**Invites.** `spaces.invites.create` makes a signed join link (`lib/spaces/invites.js`) with `id`, `space`, `role`, `scope`, `expires` and `uses`, signed by the Space's root key. `spaces.invites.preview` checks it against the pinned key. A link lives 7 days by default, at most 30, and takes at most 100 uses. The input `seats` lists `{ project, level }`. When someone accepts, the `work` module hears invite.used and seats the joiner on each named project through `setSeatLevel`. A replay leaves an edited seat alone (`core/work/invite-seats.test.js`).

**Kernel checks.** Each tool in `core/spaces/module.json` declares a reach. `person` tools run under the caller's own chain. `modules` tools serve other modules. `spaces.invites.redeem` and `spaces.code.submit` are open to anyone, since the caller is not a member yet. Role changes go to the kernel (`grants.role`, `grants.member`, `grants.invite`), which decides again. A refused act reads as absence (`not_found`) and writes access.denied.

**Data.** SQLite tables `spaces_space`, `spaces_member`, `spaces_member_person`, `spaces_invite`, `spaces_invite_space`, `spaces_role_name`, `spaces_pairing` and `spaces_kv` (`core/spaces/store.js`). For a server-hosted Space the kernel's own membership and grants are the source of truth (`core/spaces/kernel-members.js`).

**Events.** member.added, member.role-changed, member.removed, member.extended, member.expired, ownership.transferred, invite.created, invite.accepted, invite.revoked, invite.expired and space.create-done.

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

- A model can call the reads, under the person's rules: `spaces.members.list`, `spaces.invites.list`, `roles.list`. Check the reach in the [Tools reference](../../reference/tools.md) first.
- These need the person's own chain or proof: `spaces.members.add`, `spaces.members.set-role`, `spaces.members.remove`, `spaces.members.transfer`, `spaces.invites.create`, `spaces.invites.confirm`, `roles.create` and `roles.assign`. The app holds role changes and invites for a yes (`apps/app/src/real/approvals.js`).
- `spaces.members.add-agent` adds an agent as a Space actor. Owners and admins call it, under the person's proof.
- `work.project.members` lists a project's team and levels for a caller who may read the project.
- See authority (agent doc "authority") and tools (agent doc "tools").

## Extend it

In 0.5 a member can read every row of a custom record type, even a row linked to a project the member is not on. Matters, tasks and files follow the project's team. 0.5.1 plans per-record privacy for custom types. A Viewer's AI reads a project's records and files through Vyre and does not open the project's folder directly. Renaming a project on a team server changes the short name that keys its folder group, so the next session there is refused until a re-key step ships. A member signs in to an AI provider with the provider's own sign-in, and sessions read the sign-ins, mail and calendar entries of that member's vault but no other items.

When a business needs a rule beyond these, build a custom module: a folder with `module.json` and an entry file that registers tools and emits events. `core/modules` loads it under the supervisor in `kernel/modules`, and its tools take a reach like any `spaces` tool. See [Modules](../../MODULES.md), [the module contract](../../build/module-contract.md), [Writing a module](../../build/writing-a-module.md) and the kernel types in `kernel/contracts/`. An agent can write that module on the business's own server. For an outside app, the planned Integration (roadmap R051-01) wraps the app's API and brings its own Flow steps, triggers, connection and agent tools. [Known gaps](../../known-gaps.md) has the full list.

## Related

- [Identity and devices](./identity-and-devices.md), [Kernel](./kernel.md), [Gate](./gate.md), [Vault](./vault.md), [Agents](./agents.md)
- [Architecture map](../map.md), [Overview](../overview.md)
- [Spaces](../../using/spaces.md), [Projects and threads](../../using/projects-and-threads.md), [Your private network](../../concepts/network.md), [Tools reference](../../reference/tools.md)
