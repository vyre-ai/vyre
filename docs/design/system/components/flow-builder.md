---
title: Flow builder
summary: A Flow read as a sentence: a trigger, then steps in order, each a card that says what it does and opens to its settings.
audience: builders
owner: app-design
status: draft
---

# Flow builder

Owner's words: Flows are "process automation and project automation", and the old Flows screen "doesnt really cover what it is". The builder makes the model obvious: When something happens, do these steps.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/flows/FlowBuilder.tsx`, `StepCard.tsx`; pure half `logic.js` (tested against the kernel's own `checkFlow`) | draft, exported from @vyre/ui |

## Shape

`<FlowBuilder draft onChange options readOnly? />`

- `draft`: `{ name, group?, trigger, steps }`. A step is `{ id, kind, ...settings }`.
- `options`: what the space offers to pick from: record types, agents, project templates (with stages and tasks), roles, people. A real source fills them from `records.types`, `agents.list`, `work.template.list` and `roles.list`.
- `flowDefinition(draft)` writes the stored Flow (`authorship: "builder"`) for `flows.define`. Nothing new is stored: every step is one the engine already has.

## Anatomy

1. **One sentence** at the top, live: "When a record is created in RefundRequests, create a RefundRequests record, then hand it to the Refunds agent with your instructions." The Flows list shows the same sentence under each name.
2. **When** card: what starts the Flow (a record is created, a record enters a stage, a person signs up, a form is submitted, a schedule, someone runs it).
3. **Step** cards in order, joined by a line. Closed, a card is its kind and one plain sentence. Open, it shows its settings and Move up, Move down, Remove step. A card that still needs something shows a warning chip in words.
4. **Add a step** opens the palette. A step the engine cannot do yet is shown with a Coming chip and cannot be picked.

## The steps

| Palette name | Stored as | Settings |
|---|---|---|
| Create a record | `create` | kind of record, copy the details it started with |
| Start a project | `call work.start-project` | playbook, name, the record to link it to. Shows the playbook's first-stage tasks and who each goes to, because the template, not the Flow, assigns them |
| Hand to an agent | `agent` | agent, task title, instructions, the record to hand over, pass the record's details and the project |
| Assign a task | `assign` | role, agent or person, the task |
| Send an email | `call comms.send` | to, subject, message. Goes through the space's sending service and is held for a yes each time |
| Wait for someone's yes | `ask` | who, the question |
| Update a record | `update` | which record, field, new value |
| Assign to a team group | none yet | Coming: the engine's assignees are person, role, teammate and pool |

## Rules

- Copy is plain words: "projects", never "matters of the template"; no em dashes.
- The agent's own instructions say who to escalate to and which email alias to use outside. The step's instructions add to them, and the card says so.
- Groups of Flows use [GroupedList](grouped-list.md).
- Sharing: a Share sheet with Can use and Can edit per person (`flows.access.get` and `flows.access.set`, the same shape agents use). Teams and roles are offered in the sample build only until the engine takes them.
- Copy says "object" for a record table.
- Every step card ends with "If something goes wrong" (`FailurePanel.tsx`, pure half `failure.js`): a time limit for one try, tries and the wait between them, which errors to try again, Check the work (`verify`), and "If this fails, run other steps" (`on_fail`). The steps of a failure path are one more lane under the card, labelled "If this fails". The Flow ends with an "If the run fails" lane (`on_failure`). The panel offers only what the engine does for the kind of step.
