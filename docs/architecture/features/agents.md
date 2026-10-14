---
title: Agents
summary: A named agent has its own instructions, memory, context and access, can be shared as Can use or Can edit, and wakes on tasks it is given.
audience: builders, agents
owner: docs
status: stable
---

# Agents

## What it is

An agent is a named, persistent helper that people chat with, assign tasks to and use in Flows. It has a folder with its instructions, a memory of what it learned, its own context files and a list of the Vault items its person gave it. The `agents` module (`core/agents`) keeps them. The built-in assistant and Engineer are agents too, and are not shared.

## What a person sees

- **Agents** home (`apps/app/screens/agents/AgentsHome.tsx`) lists the agents. **New agent** (`apps/app/screens/assistants/NewAgent.tsx`) makes one.
- An agent page (`apps/app/screens/assistants/AgentPage.tsx`) shows its work (`AgentWork.tsx`), its instructions, context, Vault items and sharing.
- **Memory** pane (`AgentMemory.tsx`): what the agent learned, each row labelled Fact, Note, Decision or Lesson, with its source ("From a chat", "From a file", "In <project>", "Added by hand"). A lesson shows the button **Make it an instruction**, and then the chip **In its instructions**.
- **Sharing** uses the access list (`apps/app/ui/components/AccessList.tsx`): **Can use** or **Can edit**, the same two words flows and the Vault use.
- **What my assistant may do** (`AssistantAccess.tsx`): the person turns areas and tools off for their own assistant.
- A task an agent failed to finish shows in Needs you as stuck, see [Tasks and Needs you](./tasks-and-needs-you.md).

## How it works

**Instructions.** An agent's instructions are `AGENTS.md`. `CLAUDE.md` beside it points at it (`core/agents/config.js`, `DOC_FILES`), and Vyre writes that pointer fresh at every launch from the stored text. Claude Code and Codex read both natively when a session runs in the agent's folder. `agents.docs.set` refuses a write to `CLAUDE.md`. Each edit is a version (`agents.versions`) and applies from the next turn. Notes an older build kept in `CLAUDE.md` are folded once under "Notes".

**Memory and lessons.** A lesson is a memory write of kind `correction`, not a store of its own (`apps/app/screens/assistants/memory-model.js`). Promoting one appends it under a `## Lessons` heading in `AGENTS.md`. "Promoted" is read from `AGENTS.md` itself, so the screen always matches the instructions. Memory scoping is in `core/memory`, see [Sessions and models](./sessions-and-models.md).

**Context and Vault.** `agents.context.add`, `.link`, `.list`, `.remove` and `.unlink` manage uploaded files and linked folders. `agents.vault.assign`, `.unassign` and `.list` give the agent use of an item without it seeing the value. Reads and edits of an agent's files, context, sharing and vault list are refused for an agent, model, MCP or harness caller (`only` in `core/agents/config.js`). The agent receives its own at session start.

**Sharing.** `agents.access.set { agent, kind: "person", subject, level }` with level `use`, `edit` or null. It mints a grant with source `agents:access:<uid>:<person>` carrying agents.use, or agents.use and agents.edit, on the agent's urn prefix. A built-in agent refuses it. Only the creator, the owner or an admin shares. In 0.5 sharing goes to a person, and a role is not offered. `agents.access.get` lists who has what.

**Project reach.** An agent has a list of projects (or `*`). `agents.ask` and `agents.spawn` with a project outside that list fail with a denial that says the person must give it that project first (`core/agents/index.js`).

**Waking on a task.** `core/daemon/agent-wake.js` subscribes to the kernel log. On task.created, task.readied or task.unblocked it reads the task. `wakes()` is true only when the task is `ready`, its doer is an agent, its source is not `manual`, it is not a follower's `fyi` note and it is under 24 hours old. It lends the agent use of that one task, then calls `agents.wake`, which starts one job thread per task and agent. A claim in its own table keeps a restart from starting anything twice. The thread id is written on the task as `form.thread`. The agent starts and submits the task itself, and the wake never marks it done. task.completed, `.approved`, `.rejected`, `.skipped` and `.voided` reclaim the lent use.

**Stuck.** If the wake throws, or the job thread ends while the task is still `ready` or `working`, `stick()` calls `agents.wake-failed` (so one retry may start it) and marks the task stuck as the agent, with a reason and a suggested fix in plain words. For an expired sign-in the reason says to reconnect the AI account. Vyre cuts secret-looking strings from the reason.

**Checks on a call.** The chain is the person, then the agent. Authority is the intersection of their grants. `agents.wake`, `agents.woken`, `agents.wake-failed`, `agents.job` and `agents.scope` have `reach: modules`, so no model can call them.

## Where the code lives

- `core/agents/` : the module (`index.js`, `config.js` instructions, context, access, `mirror.js`, `wake.test.js`).
- `core/daemon/agent-wake.js` : the task-to-wake watcher.
- `core/pluginagent/` : Claude Code on a computer as a named agent.
- `core/team/` : project teammates, a persistent agent per role per project.
- `core/memory/` : what agents learn and recall.
- `apps/app/screens/agents/`, `apps/app/screens/assistants/` : home, page, memory, access.
- `kernel/tasks/tasks.js` : the task states and `stuck`.

## How agents use it

- Open to agents: `agents.list`, `agents.create`, `agents.update`, `agents.ask`, `agents.rollover` (each `reach: anyone`, still bounded by the caller's grants), and `agents.spawn` for a short-lived helper that works as you with your access or less.
- An agent cannot read or change another agent's files, context or sharing.
- Held or person-only acts (a send, a payment) go through `gate.request`, see [Gate](./gate.md).
- See agents index (agent doc "index"), skills (agent doc "skills") and authority (agent doc "authority").

## Extend it

In 0.5 provider coverage differs ([Sessions and models](./sessions-and-models.md)). An agent step has no deadline: a session that ends without finishing is marked stuck, and a session that never ends is not timed out. 0.6 plans a due time and a failure path on agent steps (roadmap R051-03) and credentials lent to a woken agent for one job (R051-02). The MCP servers a member signs in to inside a session do not carry to the next session.

A custom module adds what the built-in agents lack. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related

- [Chats](./chats.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Sessions and models](./sessions-and-models.md), [Vault](./vault.md), [Flows](./flows.md), [Kernel](./kernel.md)
- [Map](../map.md), [Overview](../overview.md)
- [Agents (using)](../../using/agents.md), [Memory](../../using/memory.md), [Teammates](../../using/teammates.md)
- [Modules reference](../../reference/modules.md)
