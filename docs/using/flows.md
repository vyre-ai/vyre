---
title: Flows and Kits
summary: A Flow is a job Vyre does for you when something happens, like a new matter or a payment. How to use one, how a Kit gives you a working set of them, and a worked example with the law firm Kit, its stage tasks and what happens when a task runs late.
audience: users
owner: docs
status: draft
---

# Flows and Kits

A **Flow** is a job Vyre does for you when something happens. A payment arrives, a form is filled in, a record moves to a new stage, or it is Monday at 8:00. The Flow runs its steps in order: it finds the record, makes a task, asks a person, drafts an email. You wrote it once, or a Kit gave it to you, and you do not run it by hand again.

A **Kit** is a ready-made set for one kind of work: the record types, the roles, the tasks and the Flows. The law firm Kit is the one used on this page.

Flows and Kits live in a space that runs on a server, which means My Cloud or a team's Cloud space. A Personal space has neither. See [Spaces](spaces.md).

## What a Flow can start from

- **A person.** You or an assistant press Run.
- **The clock.** Every day at 7:00, or every Monday. A schedule uses the space's time zone, never the server's, and can keep to business hours, skip holidays, and say what to do about the times it missed while the server was off. See [time zones](time-zones.md).
- **A change.** A record is made or changed, or a record enters a stage, such as a project entering Drafting.
- **A form or a link.** Someone fills in a form on your site, or another program calls your Flow's address.
- **A watcher.** Something new shows up in a place Vyre watches, such as a mailbox or a folder. See [watchers](watchers.md).

A module you add can offer its own starting points, such as "A document is signed". It names them, and you pick one like any other.

## What a Flow can do

A Flow is a list of steps. In plain words, a step can:

- find, make, change or remove records;
- choose between two paths, or repeat for every record in a list;
- do two or more things at the same time and carry on when all of them are done, or run another Flow and use what it gives back;
- wait for a time, or for a person;
- ask a person to decide, or give a task to a person or an assistant;
- run one of the tools Vyre or a module offers, such as "send an email";
- have an assistant read a document, sort it or pull facts out of it, and use only what you allowed it to see.

Open **Flows** in the Vyre app to see yours. Each one shows whether it runs on its own, its run history, and the steps. **See as code** shows the same Flow as text, for people who like that.

A run is about the record that started it. Open that record or its project and its timeline lists the run in plain words, next to the emails, tasks and documents: "Welcome the client: done", or "Welcome the client: did not finish".

### Doing things at the same time

A **parallel** step has two to eight lanes. Each lane is its own list of steps. The lanes start together, and the step after the parallel step starts when every lane is done. A lane can wait for a person while the others finish. If a lane fails, the others still finish, then the parallel step fails and says which lane did not finish and why. Retry the run and only the lane that failed goes round again.

Steps after the parallel step can read anything a lane made, by the step's name. Lanes cannot read each other. A Flow that allows only one run at a time (`concurrency: 1`) runs its lanes one after the other, since each lane is a run.

Each lane shows in the Flow's run list as a run of its own, marked as belonging to its parent, so a lane that needs a person is in your Now list like any other.

### Running another Flow

A **run another Flow** step names a Flow that is already switched on in this space and hands it some input. The step is done when that Flow is. The Flow can say what it gives back with `returns`, and the steps after read it as `steps.<step>.result`. The Flow that makes the call needs your yes to run other Flows, and each call is checked the same way a run by hand is. A Flow that runs itself stops after eight levels and says so.

### Try it on last week

Before you switch on a change, Vyre replays the last week through it. Nothing is done: every action is a stand-in. When the Flow has really run that week, you see the two side by side: "In that time it really ran 12 times. This version would run 12 times: 11 the same, 1 different, 0 new, 0 it would not run." A different run says which steps it did and which this version would do. Ask your assistant to try a Flow on last week, or look at the line on the approval card.

## You say yes before it runs

A Flow does nothing until a person approves it. Approving covers exactly the version you read. If someone changes it, it waits for your yes again.

A step that leaves Vyre, like sending an email or posting to a site, is held for your yes **each time it would happen**. You see the draft in Now, you approve or refuse it, and only then does it go out. A Flow an assistant wrote works the same way: it cannot send anything on its own.

A step that comes from a module you added is always held like this, whatever the module says about itself. Only Vyre's own modules are trusted to say a step is safe to run without asking.

## Make one

There are three ways.

1. **Install a Kit.** Open **Kits**, pick one and press **Install**. The install card lists everything the Kit adds and what could surprise you: sealed fields, steps that send email, outside text. Nothing is installed until you say yes.
2. **Ask for one.** Write to **@Engineer** in a chat and say what should happen and when. It drafts a Flow and proposes it. You read it and approve it.
3. **Write it as code.** For people who want to. **See as code** on any Flow.

## A worked example: the law firm Kit

The law firm Kit gives a firm the records it needs (leads, appointments, clients and projects), two roles, **attorney** and **paralegal**, and the tasks that move a case along.

### Put it on your space

From a terminal on the computer where you use Vyre:

```
vyre kit deploy law-firm
```

One command. The law firm Kit builds on the base Kit, so Vyre proposes the base Kit first and the law firm Kit second. Each one is a card waiting for your yes in Now (`vyre needs` lists them). Say yes to both and the Kit is installed. Nothing installs before that. Run `vyre kit` to see which Kits are on offer and which are installed.

If you also install the estate planning Kit, the attorney role is still one role. The second Kit adds its permissions to the role the first one made.

### Stages are made of tasks

A project follows the stages of its practice area. A personal injury case goes through Intake, Treating, Demand, Negotiation, Settled and Closed. An estate plan goes through Intake, Drafting, Review, Signing, Funding and Closed. A lead has its own: New, Contacted, Meeting booked, Qualified, Converted or Lost.

Each stage lists the tasks its work is made of. When a record enters a stage, Vyre makes those tasks, once, and gives each to the right person:

| Stage | Task | Who does it | Due |
| --- | --- | --- | --- |
| Estate plan, Intake | Collect family and asset details | A paralegal | 3 days |
| Estate plan, Drafting | Draft the documents | An attorney | 1 week |
| Personal injury, Demand | Draft the demand letter | An attorney | 2 weeks |
| Lead, New | Call the lead back | A paralegal | 1 day |

You find your tasks in Now. When the required tasks of a stage are done, the record moves on to the next stage by itself. A stage with no tasks waits for a person to move it. If you move a record by hand before its tasks are done, Vyre leaves it where you put it.

The Kit does not need to know anyone's name. It asks for the **attorney** or the **paralegal**, and Vyre finds the person in your team who holds that role.

### Every stage has an owner

A stage names an owner. In the law firm Kit the owner is the attorney. The owner is who answers for the stage when its work runs late.

### What happens when a task runs late

Every task in these stages has a due time. If a task is still open when its due time passes, Vyre puts a new to-do in front of the stage's owner: **Late: Draft the documents**, with a line saying who has had it and for how long. It happens once for that task. The late task stays with the person who had it. The owner decides: nudge them, take it over, or move the date.

Vyre uses the planner's clock for this, the same one that rings your alarms, so there is nothing to set up.

## What to check when something does not run

- **It never started.** Open the Flow and look at **Runs on its own**. A Flow made by a Kit needs your approval once.
- **It started and stopped at a step.** Open the run in **Run history**. A step that sends email is waiting for your yes in Now.
- **A record did not move to the next stage.** Look at its tasks. A stage moves on only when the required ones are done. A stage can also have an entry condition, such as "Signing needs a trust name", and the record stays put until it holds.
- **A Flow was paused.** A Flow that runs away, or whose result does not match what it sent, is paused and tells you why in Now. Fix the cause, then resume it.

## Next

- [Spaces](spaces.md): where Flows and Kits can live.
- [Teammates](teammates.md): roles for your assistants, and how to ask one for work.
- [The planner](planner.md): the clock behind schedules and late tasks.
- [Modules](../MODULES.md): how a module adds its own steps and starting points to Flows.
