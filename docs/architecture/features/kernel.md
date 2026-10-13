---
title: Kernel
summary: The trusted core that builds who is calling, decides every call, keeps the event log, and holds sealed values and the model door.
audience: builders, agents
owner: docs
status: stable
---

# Kernel

## What it is

The kernel (`kernel/`) is the small trusted core, one per Space. It builds the acting chain, decides with one function whether a call may run, writes a hash-chained event log, keeps records, seals secret values in a separate process, and gates every model call. The same code runs on a server, a phone and a browser, so it imports almost nothing (`kernel/DEPENDENCIES.md`).

## What a person sees

The kernel has no screen of its own. A person meets it as its results:

- A refused act reads like absence: a record the caller may not read is "not found", and the true reason is written to the log as `access.denied` (`kernel/core/gate.js`).
- A held act becomes a card in Needs you (see [Gate](./gate.md)).
- A Viewer on a project is told "You have read-only access to this project (viewer). Ask the project's owner or a lead to make you a contributor." (`lib/seat-levels.js`).

## How it works

**Composition.** `kernel/index.js` `createKernel` wires one Space: event log, store, chain builder, grants store, limits, tasks, rule evaluator (`kernel/expr`), sealing client, door and gateway. `kernel/boot.js` does it with the durable store; a restart rebuilds grants, members and meters by replaying the log. `kernel/spaces/` holds one kernel per Space; a Space on another machine is reached through `kernel/remote/` over Wink or the relay.

**The chain** (`kernel/core/chain.js`). Only the kernel builds a chain; it is a frozen object kept in a private set, so a hand-made one is not a chain. It is built from facts a surface verified, never a header string. Surfaces `cli`, `local`, `deck` and `capsule` are person surfaces; `mcp` and `harness` are model surfaces. Authority only narrows along hops. Approval is accepted only from a chain that is exactly one person (`isExactlyPerson`).

**Authorize** (`kernel/core/authorize.js`). One pure decision, deny by default: check the Space, find candidate grants for each hop, take the effective grant per hop, check narrowing, return policy obligations (`audit`, `presence`, `ask`, `meter`, `rate`, `placeholders`, `fields`, `once`, `draft_only`). An obligation it cannot recognise becomes an ask. A wildcard covers only read and write actions that existed when the grant was made; admin, grant and outward actions must be named. `containsDims` checks a child grant against its parent on every dimension and fails on any it cannot compare.

**Grants** (`kernel/grants/`). A membership expands to grants with source `role:<id>` (`roles.js`). Grants carry actions, a resource prefix, row predicates, fields, conditions (`where`, `when`, `how`, `audience`, `delegate`, `budget`, `rate`, `once`), and are rebuilt from the log. A grant to a team reaches each person in it.

**Gate** (`kernel/core/gate.js`). Allow returns the decision. Ask throws what is needed, with the decision id and obligations. Deny looks like absence. `kernel/core/limits.js` counts `once`, `rate` and `budget`, atomically, and replays them from the log after a restart.

**Event log** (`kernel/core/events.js`). The envelope is built only from a chain. `commit` is a salted commitment to the data, `hash` covers the envelope with data replaced by the commit, `prev` links to the one before, so erasing data leaves the chain verifiable. `kernel/audit/` signs `{ space, seq, hash, time, key_id }` with the Space key every 1,000 events or 10 minutes and appends `checkpoint.signed`; a device keeps the latest checkpoint it has seen, so a rollback or split history is caught.

**Store** (`kernel/store/`). `memory.js` is the reference store; `sqlite.js` writes through to `kernel_types`, `kernel_records`, `kernel_changes`, `kernel_attrs`, `kernel_flags`, `kernel_counts` in one transaction per change, with memory bounded by a small cache. `sealed.js` keeps Personal items as ciphertext. `kernel/conformance/` is the suite every store, log and sealing process must pass.

**Seal** (`kernel/seal/`). The sealing process is a separate process and the only place sealed plaintext exists besides the person's reveal view. It speaks newline-delimited JSON on stdin and stdout, held only by the spawner. Ops include `put`, `use`, `deliver`, `reveal`, `detect`, `reseal`, `export`, `import`. Sealed classes are a fixed set of detectors (`classes.js`); a Kit or module cannot add one with code. An error carries a code and nothing from the input.

**Door** (`kernel/door/door.js`). Every model call passes: declared sinks only (`sinks.json`), bounds, residency, budget, then each message is scanned and sealed-looking values become placeholders, and the session's ledger refuses a prompt that still holds a value the session resolved or revealed. What comes back is scanned too. A refusal names the rule and the class, never the value.

**Identity chain.** `kernel/identity/chain.js`: see [Identity and devices](./identity-and-devices.md).

**Golden files** (`kernel/golden/`). The recorder asks every tool, for every caller shape and world (`bare`, `person`, `person+proof`, `person+proof+said`, `named`), in a child process, and compares to `golden.json`. A refresh fails if any cell moves from refused to run unless `allow.json` names it with a reason, or if a new tool runs for a model, guest or MCP caller without an entry. Each role (`box`, `local`) and run (`plain`, `gates`, `generated`) is its own test file.

**Contracts.** `kernel/contracts/` holds types and frozen tables, no logic. Changes are additive only.

## Where the code lives

- `kernel/index.js`, `kernel/boot.js`, `kernel/home.js`: composition and boot.
- `kernel/core/`: chain, authorize, gate, events, limits, presence, URNs, fields.
- `kernel/grants/`: grants, members, roles.
- `kernel/gateway/`: records, events, grants, sealed uses, ownership, project members.
- `kernel/store/`: memory, SQLite and sealed stores.
- `kernel/audit/`: signed checkpoints.
- `kernel/seal/`: sealing process, ledger, attestation and proof checks.
- `kernel/door/`: the model door and its sink list.
- `kernel/identity/`: the identity chain and recovery stretch.
- `kernel/golden/`: pinned decision set and allow lists.
- `kernel/remote/`, `kernel/spaces/`, `kernel/tasks/`, `kernel/flows/`, `kernel/expr/`: remote kernels, per-Space kernels, tasks and approvals, Flow runner, rule language.

## How agents use it

- An agent never calls the kernel directly. It calls a module tool, and the dispatcher builds the chain from the session token, so a model cannot name a person or widen its own authority.
- Reach decides who may call: `anyone`, `asked` (may hold for a yes), `person`, `modules`. A refused call returns `not_allowed`; do not look for a way around it.
- A model call goes through the door; a sealed value reaches a model only as a placeholder.
- See authority (agent doc "authority"), tools (agent doc "tools") and sealed and secrets (agent doc "sealed-and-secrets").

## Limits today

- Sessions started by hand in a box's container do not run as the separate user, so Vyre's checks on their tool calls are the protection there.
- There is no Gate on shell sends or shell file changes: a message sent some other way, such as `curl` to a mail API, is not recognised as a send.
- `kernel/door/sinks.json` lists files in `retrofit_pending` that still reach providers directly; they move behind the door later.
- Custom record types are readable by every member (per-record privacy planned for 0.5.1).

## Related

- [Spaces and members](./spaces-and-members.md), [Identity and devices](./identity-and-devices.md), [Gate](./gate.md), [Vault](./vault.md), [Records](./records.md), [Relay and networking](./relay-and-networking.md)
- [Architecture map](../map.md), [Overview](../overview.md), [Boundaries](../boundaries.md)
- [Security floor](../../concepts/floor.md), [Presence](../../concepts/presence.md), [Security](../../security/index.md)
