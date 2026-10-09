---
name: build-a-template
description: Use when asked to build, change, try or explain a project template (stages, tasks, who does each, what needs a yes), to set up how a kind of work runs, or to change an agent's own instructions.
---

# Build a project template

A project template is stages and tasks a project follows. Each task has a doer, a checklist that proves it done, what needs a person's yes, who to ask when stuck, and the Connections it may use. Vyre writes each task's brief from those choices, so you do not write briefs by hand unless one needs it.

## Shape

```
{ name, description?, tags?, roles: [{ role, agent?, lead? }],
  stages: [{ name, owner?, moves_on_when?, tasks: [{ title, doer, output: { kind }, checker?, checklist?, credentials?, context?, needs_yes?, ask?, depends_on?, due_offset_ms?, required? }] }] }
```

- `doer` is `role:researcher`, `teammate:research`, `person:alex` or `owner`. A `role:` doer is filled by the agent the template names for that role, else a person with that role in the Space.
- `output.kind` is one of note, draft, decision, file, sent, fields. A `sent` task is held for a yes.
- A stage moves on when its required tasks are done and, if the stage before it has `moves_on_when`, that condition holds. `owner` (`role:x` or `person:x`) may move a stage early, with a reason that is kept.
- At most one role is the project lead. Give a role an `agent` from the roster to make it a teammate.

## Do it

1. `tools_call work.template.library` shows what the Kits ship; `tools_call work.template.install` adds one as a draft. Start from it when one fits.
2. `tools_call work.template.define { body }` stores a new DRAFT version. Nothing runs from a draft.
3. `tools_call work.template.test { template, version, sample }` shows every stage, task, doer, brief and checklist with nothing created or sent. Read it as the person who will use it, fix what reads wrong, define again.
4. `tools_call flows.propose { what: "template", template, version }` puts one card in front of the template's owner. Their yes puts the version live; projects already running keep the version they started with.
5. A Flow starts a project with the step `tools_call work.start-project { template, name }` (for example when a record reaches a stage).

## Change an agent

Never edit an agent. Propose: `tools_call flows.propose { what: "agent", agent, patch: { instructions?, skills?, model?, effort?, tags? } }`. The agent's owner approves on one card; each approved change is a version (`tools_call agents.versions`) that can be rolled back. Permissions (projects, credentials, a computer) are the person's own act and are not in a proposal.

## Skills and plugins

A skill is a SKILL.md with `name` and `description` in its front matter; the description is what an AI reads to choose it. `tools_call skills.draft { name, level, scope?, body }` writes a DRAFT at a level: `space` (everyone's agents), `personal`, `agent` (scope: the agent's name) or `project` (scope: its short name). Nothing uses a draft. `tools_call flows.propose { what: "skill", name, level, scope, version }` puts one card in front of the level's owner. A plugin is `kind: "plugin"` with JSON `{ name, description, skills?, commands?, hooks?, mcp? }`; one with a hook or an MCP server has code, and the card shows exactly what it declares. Never put a key in a skill.

## Say it plainly

After you propose, say what the template does in two or three sentences and that it waits for a yes. Do not claim it is live.
