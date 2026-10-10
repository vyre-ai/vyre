---
title: Project templates
summary: How a project runs from a template of stages and tasks, how to write, try and put a template live, how to start a project from one, and how an agent's change to itself is approved.
audience: users, agents
owner: docs
status: stable
---

# Project templates

A **project template** is the way a kind of work runs: stages, and in each stage the tasks that must be done, who does each, and how anyone knows it is done. A project started from a template follows it. A project started without one is just chats and files, like a Claude or ChatGPT project, and needs nothing from this page.

## What a template holds

- **Stages**, in order. A stage moves on when its required tasks are done and, if the stage before it says `moves_on_when`, that condition holds on the project. Its `owner` (`role:attorney` or `person:alex`) may move it on early, with a reason that is kept.
- **Tasks** in a stage. Each has a doer (`role:researcher`, `teammate:research`, `person:alex` or `owner`), what it produces (`note`, `draft`, `decision`, `file`, `sent` or `fields`), an optional checker, and a checklist that proves it done. A task can also name what needs a yes, who to ask when stuck, and the Connections it may use.
- **Roles**, each optionally filled by an agent on the roster. At most one role is the project lead.

Every task gets a written **brief** from those choices: the goal and how it is known to be done, the context, what waits for a person's yes, who to ask, the checklist and the Connections. You write a brief by hand only when the generated one is not right.

## Write, try, put live

1. `work.template.define` stores a new **draft** version. Nothing runs from a draft.
2. `work.template.test` shows every stage, task, doer, brief and checklist on a sample project. Nothing is created, sent or changed.
3. `work.template.golive` puts a draft live. Only the template's owner or an admin can. The version that was live is retired.

An agent, or @Engineer, proposes the same step with `flows.propose { what: "template", template, version }`: one card in Now for the owner, and their yes puts the version live. In the app, `/u/templates` is the studio: the tree, Test mode, Go live and an editor that saves a new draft.

Kits can ship templates. `work.template.library` lists them and `work.template.install` adds one as a draft; the law-firm Kit ships Estate plan.

## Start a project

In the app, open the template (Projects, Templates) and use **Start a project**: type the project's name, press **Start project**, and the new project opens with its team, its stages and the first stage's tasks in Now. The same thing for an assistant or a Flow is `work.start-project { template, name }`: it makes the project, adds the roles' agents as its teammates, pins the template's stages on the project, and makes the first stage's tasks. It is also a Flow step, "Start a project from a template", so a record reaching a stage can start one.

If a task cannot be made because its assistant is not in the space yet, the project still starts and the app says which tasks were skipped and why ("research is not in this space yet"); `work.start-project` answers `tasks_made` (how many) and `tasks_skipped` (each task and its reason). Add the assistant to the space and start again. The project's timeline begins with "Started from the Estate plan template", and its Team tab lists who is on the team and the role each fills.

A running project keeps the version it started with. Putting a newer version live, or retiring one, changes no project that is already running. `work.template.from-project` makes a draft template from a project that ran one.

## An agent's change to itself

An agent's instructions, skills, model, effort and tags change by conversation. Tell the agent, or tell your assistant. The agent proposes the change (`flows.propose { what: "agent", agent, patch }`), the agent's owner approves on one card, and the change is a version. `agents.versions` lists them and `agents.update { agent, rollback: n }` restores one. Nobody but a person edits an agent directly, and permissions (projects, credentials, a computer) are never part of a proposal.
