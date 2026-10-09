---
title: Finding and calling tools
summary: How tools are named, which ones you may call, how a Space's own tools are generated, and what a held or failed result means.
audience: agents
owner: docs
status: stable
tokens: 1250
when: You need a tool and do not know its name, a tool you expected is missing, or a call returned a held result.
---

# Finding and calling tools

## What you are listed, and the rest

Your tool list is short on purpose: about two dozen tools you will want most (memory, recall, a Space's records through `work_tools` and `work_call`, the planner, Flows, Connections, the Vault, files, asking a teammate, docs, skills) plus `tools_find`, `tools_run`, `results_read`, `tools_call` and `vyre_core`. Every other tool you may use is still there. Say what you are about to do to `tools_find` ("search my inbox") and it returns the best three, each with a ready call; run one with `tools_call`. `vyre_core` lists Vyre's modules and whether each is running here. A tool you may not use is never found, the same as a skill you may not use.

## Names

A tool is `module.verb`, lowercase, dots for sub-areas: `recall.search`, `records.list`, `tasks.request`. The MCP server turns the dot into an underscore (`recall_search`). The module is the first part: it tells you which area owns the tool.

<!-- agent:tools:start -->

Reach classes: `anyone`, `asked`, `person`, `modules`, `hook`.

Tool families, each a module name and how many tools it has: vault 135, spaces 112, memory 70, threads 67, wink 66, files 49, chrome 42, relay 40, sessions 39, work 38, flows 35, github 33, team 32, computers 31, link 30, artifacts 28, connectors 28, projects 24, records 23, google 21, presence 21, watchers 20, publish 19, bridges 17, recall 17, appmods 16, planner 16, learn 15, agents 14, onboard 14, gate 13, glass 13, hands 12, stream 12, approvals 11, mcp 10, rules 10, settings 10, sync 10, mail 9, pluginagent 9, runner 9, assistant 8, names 8, push 8, harness 7, tips 7, apps 6, capsule 6, hooks 6, import 6, signin 6, tasks 6, goals 5, modules 5, sidebar 5, sight 5, system 5, vitals 5, hands-desktop 4, network 4, spend 4, term 4, voice 4, appearance 3, mentions 3, sideview 3, skills 3, suggest 3, undo 3, update 3, views 3, context 2, docs 2, releases 2, screen 2, waiting 2, about 1, commands 1, events 1, providers 1, statusline 1, vyre 1.

<!-- agent:tools:end -->

## A Space's own tools

For a Space's records, ask `work.tools`: it lists the tools you may use in this Space, generated from its record types and cut by your grants. A tool you may not use is not listed, so a missing tool means "not for you here", not "broken". Run one with `work.call`, giving the tool name and its input. The result says what to show: a record card, a task card, a draft, or a held-for-approval card.

For each record type the generated tools are `find`, `create` and `update`, `move_stage` for a type with stages, tasks tools, and one tool per outward action.

## Read results

- **Success** returns data. Read the fields you asked for and no more.
- **Held** means a person must approve before it happens (read `outward-acts.md`). Do not repeat the call.
- **Failure** returns a code and a message. `errors.md` says what each code means and the one next step.

## Reach

Every tool has a reach that says who may call it. As an agent you can call tools with reach `anyone`, `asked` (it may hold for a yes) and some `person` tools the person's rules open to you. A tool whose reach excludes you is refused with `not_allowed`. Do not look for a way around it.

## Batching and handles

When one job is several calls that depend on each other ("find the client, then their matters, then the open ones"), send them in one `tools_run` instead of one turn each. A step is `{ id, call, input }`; a value `{ expr: "steps.c.rows[0].id" }` reads an earlier step's result (the Flows expression language: comparisons, `len`, `lower`, `coalesce`, no loops). `when` skips a step. `{ id, fn, inputs }` shapes data in the Flows code sandbox; it can never call a tool. `return` names the one answer you want. Each step is judged as if you had called it alone: the same grants, the same Gate. The script stops at a step that is held (the answer gives the held id and the step; after the person decides, send a new `tools_run` from the next step), refused or failed, and says which steps ran. A tool that needs the person's proof, `tools_run` itself, and the tools that wait on another session do not run inside it.

A result over about 2,000 tokens is not put in your context. You get `{ handle, tokens, summary }`: the shape and the first three items. `results_read` with `{ handle, select, offset, limit }` returns the part you need (`select` is a path such as `rows[0].name`; a list pages). A handle is yours alone, lives 30 minutes and is gone if the session restarts: run the call again. `tools_call results_drop` frees one early.

## Cheapest path

- Prefer one specific tool over searching broadly. `records.list` with a filter beats listing everything.
- Ask for a page and a limit, not everything.
- Read one section of a doc (`docs.read` with a heading) rather than a whole page.
- When you will not need a result again, do not fetch more than you use.
