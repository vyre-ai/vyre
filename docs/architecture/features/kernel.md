---
title: Kernel
summary: The trusted core that builds who is calling, decides every call, keeps the event log, and holds sealed values and the model door.
audience: builders, agents
owner: docs
status: stable
---

# Kernel

## What it is

The kernel (`kernel/`) is the small trusted core, one per Space. It builds the acting chain, decides with one function whether a call may run, writes a hash-chained event log, keeps records, seals secret values in a separate process and gates every model call. The same code runs on a server, a phone and a browser, so it imports almost nothing (`kernel/DEPENDENCIES.md`).

## What a person sees

The kernel has no screen. A person meets its results:

- A refused act reads as absence. A record the caller may not read is "not found", and the true reason goes to the log as access.denied (`kernel/core/gate.js`).
- A held act becomes a card in Needs you, see [Gate](./gate.md).
- A Viewer on a project reads "You have read-only access to this project (viewer). Ask the project's owner or a lead to make you a contributor." (`lib/seat-levels.js`).

## How it works

**Composition.** `createKernel` in `kernel/index.js` wires one Space: event log, store, chain builder, grants store, limits, tasks, rule evaluator (`kernel/expr`), sealing client, door and gateway. `kernel/boot.js` does it with the durable store, and a restart rebuilds grants, members and meters by replaying the log. `kernel/spaces/` holds one kernel per Space. A Space on another machine is reached through `kernel/remote/` over Wink or the relay.

**The chain** (`kernel/core/chain.js`). Only the kernel builds a chain. It is a frozen object kept in a private set, so a hand-made one is not a chain. The kernel builds it from facts a surface verified, never from a header string. The surfaces `cli`, `local`, `deck` and `capsule` are person surfaces, and `mcp` and `harness` are model surfaces. Authority only narrows along hops. The kernel accepts an approval only from a chain that is exactly one person (`isExactlyPerson`).

**Authorize** (`kernel/core/authorize.js`). One pure function decides, and the default is deny. It checks the Space, finds candidate grants for each hop, takes the effective grant per hop, checks narrowing and returns policy obligations: `audit`, `presence`, `ask`, `meter`, `rate`, `placeholders`, `fields`, `once` and `draft_only`. An obligation it does not recognise becomes an ask. A wildcard covers the read and write actions that existed when the grant was made. Admin, grant and outward actions must be named. `containsDims` compares a child grant with its parent on every dimension and fails on any it cannot compare.

**Grants** (`kernel/grants/`). A membership expands to grants with source `role:<id>` (`roles.js`). Grants carry actions, a resource prefix, row predicates, fields and conditions (`where`, `when`, `how`, `audience`, `delegate`, `budget`, `rate`, `once`), and the log rebuilds them. A grant to a team reaches each person in it.

**Gate** (`kernel/core/gate.js`). Allow returns the decision. Ask throws what is needed, with the decision id and obligations. Deny looks like absence. `kernel/core/limits.js` counts `once`, `rate` and `budget` atomically and replays them from the log after a restart.

**Event log** (`kernel/core/events.js`). Only a chain can build the envelope. `commit` is a salted commitment to the data. `hash` covers the envelope with the data replaced by the commit, and `prev` links to the event before, so erasing data leaves the chain verifiable. `kernel/audit/` signs `{ space, seq, hash, time, key_id }` with the Space key every 1,000 events or 10 minutes and appends checkpoint.signed. A device keeps the latest checkpoint it has seen, which catches a rollback or a split history.

**Store** (`kernel/store/`). `memory.js` is the reference store. `sqlite.js` writes through to `kernel_types`, `kernel_records`, `kernel_changes`, `kernel_attrs`, `kernel_flags` and `kernel_counts` in one transaction per change, with memory bounded by a small cache. `sealed.js` keeps Personal items as ciphertext. `kernel/conformance/` is the suite every store, log and sealing process must pass.

**Seal** (`kernel/seal/`). The sealing process runs apart from the kernel. Besides the person's reveal view, it is the only place sealed plaintext exists. It speaks newline-delimited JSON on stdin and stdout, held only by the spawner. Its ops include `put`, `use`, `deliver`, `reveal`, `detect`, `reseal`, `export` and `import`. Sealed classes are a fixed set of detectors (`classes.js`), and a Kit or module cannot add one with code. An error carries a code and nothing from the input.

**Door** (`kernel/door/door.js`). Every model call passes the door. It allows declared sinks only (`sinks.json`), then checks bounds, residency and budget, then scans each message and turns sealed-looking values into placeholders. The session's ledger refuses a prompt that still holds a value the session resolved or revealed. The door scans what comes back too. A refusal names the rule and the class and never the value.

**Identity chain.** `kernel/identity/chain.js`, see [Identity and devices](./identity-and-devices.md).

**Golden files** (`kernel/golden/`). The recorder asks every tool, for every caller shape and world (`bare`, `person`, `person+proof`, `person+proof+said`, `named`), in a child process, and compares the answers to `golden.json`. A refresh fails when any cell moves from refused to run unless `allow.json` names it with a reason. It also fails when a new tool runs for a model, guest or MCP caller without an entry. Each role (`box`, `local`) and run (`plain`, `gates`, `generated`) is its own test file.

**Contracts.** `kernel/contracts/` holds types and frozen tables with no logic. Changes there are additive only.

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
- Reach decides who may call: `anyone`, `asked` (may hold for a yes), `person` or `modules`. A refused call returns `not_allowed`. Do not look for a way around it.
- A model call goes through the door, and a sealed value reaches a model only as a placeholder.
- See authority (agent doc "authority"), tools (agent doc "tools") and sealed and secrets (agent doc "sealed-and-secrets").

## Extend it

The kernel stays small, and growth happens in modules around it. In 0.5 the Gate recognises a send made through a Vyre tool. A message sent some other way, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. Sessions Vyre runs on a Docker box run as a separate user. A Claude Code started by hand in the box's container does not, so Vyre's checks on its tool calls cover it. `kernel/door/sinks.json` lists four files under `retrofit_pending` that still reach model providers directly and are due to move behind the door. A custom record type is readable by every member until per-record privacy arrives in 0.5.1.

When a business needs a new capability, build a custom module: a folder with `module.json` and an entry file that registers tools and emits events. `core/modules` loads it and runs it under the supervisor in `kernel/modules`. Its tools get a reach, and the kernel decides every call to them with the same `authorize` function. The types it relies on live in `kernel/contracts/`. See [Modules](../../MODULES.md), [the module contract](../../build/module-contract.md) and [Writing a module](../../build/writing-a-module.md). An agent can write that module on the business's own server. For an outside app, the planned Integration (roadmap R051-01) wraps the app's API and brings its own Flow steps, triggers, connection and agent tools. [Known gaps](../../known-gaps.md) has the full list.

## Related

- [Spaces and members](./spaces-and-members.md), [Identity and devices](./identity-and-devices.md), [Gate](./gate.md), [Vault](./vault.md), [Records](./records.md), [Relay and networking](./relay-and-networking.md)
- [Architecture map](../map.md), [Overview](../overview.md), [Boundaries](../boundaries.md)
- [Security floor](../../concepts/floor.md), [Presence](../../concepts/presence.md), [Security](../../security/index.md)
