---
title: Finding and calling tools
summary: How tools are named, which ones you may call, how a Space's own tools are generated, and what a held or failed result means.
audience: agents
owner: docs
status: stable
tokens: 850
when: You need a tool and do not know its name, a tool you expected is missing, or a call returned a held result.
---

# Finding and calling tools

## Names

A tool is `module.verb`, lowercase, dots for sub-areas: `recall.search`, `records.list`, `tasks.request`. The MCP server turns the dot into an underscore (`recall_search`). The module is the first part: it tells you which area owns the tool.

<!-- agent:tools:start -->

Reach classes: `anyone`, `asked`, `person`, `modules`, `hook`.

Tool families, each a module name and how many tools it has: vault 135, spaces 112, memory 70, threads 67, wink 66, files 49, chrome 42, relay 40, sessions 39, work 38, github 33, team 32, computers 31, link 30, artifacts 28, connectors 28, flows 24, projects 24, records 23, google 21, presence 21, watchers 20, publish 19, bridges 17, recall 17, appmods 16, planner 16, learn 15, agents 14, onboard 14, gate 13, glass 13, hands 12, stream 12, approvals 11, mcp 10, rules 10, settings 10, sync 10, mail 9, pluginagent 9, runner 9, assistant 8, names 8, push 8, harness 7, tips 7, apps 6, capsule 6, hooks 6, import 6, signin 6, tasks 6, goals 5, modules 5, sidebar 5, sight 5, system 5, vitals 5, hands-desktop 4, network 4, spend 4, term 4, voice 4, appearance 3, mentions 3, sideview 3, suggest 3, undo 3, update 3, views 3, context 2, docs 2, releases 2, screen 2, waiting 2, about 1, commands 1, events 1, providers 1, statusline 1.

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

## Cheapest path

- Prefer one specific tool over searching broadly. `records.list` with a filter beats listing everything.
- Ask for a page and a limit, not everything.
- Read one section of a doc (`docs.read` with a heading) rather than a whole page.
- When you will not need a result again, do not fetch more than you use.
