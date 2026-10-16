---
title: Roadmap
summary: Where Vyre is going, line by line, with what each release contains.
audience: users, builders, operators, agents
owner: docs
status: stable
---

# Roadmap

This is direction, not a promise of dates. Item ids such as R051-01 are stable names: they do not change when an item moves to another release. Each line has an ID; a line is ticked when it ships in a release. What is true today is in the [releases](https://github.com/vyre-ai/vyre/releases) and [known gaps](known-gaps.md).


## 0.5.0
- [x] R050-01 People and agents in the same chats; anyone in a Space makes an agent and shares it as use-only or full.
- [x] R050-02 A task given to an agent wakes it; it finishes, hands on, or is marked stuck with a reason.
- [x] R050-03 One AGENTS.md instructions file per agent and per project, with @ and # references.
- [x] R050-04 Flows: more triggers (schedules with business hours and holidays, record changes, stages), wait until a date or event, find or create, readable dates in text, approvals and a run page.
- [x] R050-05 Playbooks: stages, tasks per stage with assignee, approver and followers, and when a stage is done.
- [x] R050-06 Records: tags, Excel and CSV import, CSV export on the web, field groups, and each field's template token shown and copyable.
- [x] R050-07 Documents from templates, sent for signature; Files with linked Google Drive and Dropbox folders.
- [x] R050-08 Vault in groups, shared as Can use or Can edit; a vault of their own for every member.
- [x] R050-09 Sites an agent builds and puts live with one yes.
- [x] R050-10 Needs you: one place for approvals, asks and stuck tasks, with typed cards.
- [x] R050-11 Teams: members reach their own things on the team's server, per-project seat levels, custom roles, and a Space-wide Google or Microsoft 365 key for each member's own mail, calendar and drive.
- [x] R050-12 Sign in by name replaces the pairing code; updates need the owner's yes.

## 0.5.1
A fix-only release: the onboarding order fix plus the stability fixes merged since 0.5.0. No new features.

## 0.6
Plan and acceptance tests: [roadmap/0.6.md](../roadmap/0.6.md).
- [ ] R051-01 One chat per Flow, with a divider per run.
- [ ] R051-02 Credentials lent to a woken agent for one job, use only.
- [ ] R051-03 Agent step deadlines that stop the agent, with a timeout path.
- [ ] R051-04 Failure panel on every step in the Flows editor.
- [ ] R051-05 Flows split into a library behind a golden replay.
- [x] R051-06 Per-record privacy for custom record types.
- [x] R051-07 Write-once fields and totals.
- [x] R051-08 Flow email with CC, BCC and attachments.
- [x] R051-09 An audit screen for admins: who changed what on a record.
- [x] R051-10 Members add a token or API key as their own AI account.
- [ ] R051-11 Load-flake hardening, so every test is green under load.
- [ ] R051-12 Flows composer and dates follow-ups.
- [ ] R051-13 Flow text and lists: brace escape, list fields, For each limit.
- [ ] R051-14 Flows over MCP for members.
- [x] R051-15 Agent wake hardening.
- [ ] R051-16 Security follow-ups from review.
- [x] R051-17 Mentions follow-ups.
- [x] R051-18 Docs re-check of known gaps.

## 0.7
Plan and acceptance tests: [roadmap/0.7.md](../roadmap/0.7.md).
- [ ] R052-01 Integration contract: what an Integration may declare.
- [ ] R052-02 Integrations section: install, verify, configure, uninstall.
- [ ] R052-03 Make an Integration from an API.
- [ ] R052-04 Clio Integration.
- [ ] R052-05 Lawmatics Integration.
- [ ] R052-06 GoHighLevel Integration.
- [ ] R052-07 DecisionVault Integration.
- [ ] R052-08 Skills screen: browse, write, version and roll back.
- [ ] R052-09 Plugins screen: install and enable per agent and project.
- [ ] R052-10 Vyre tax eval as a release gate.
- [ ] R052-11 Fewer tools loaded up front, the right one picked.
- [ ] R052-12 Shorter agent docs without losing capability.
- [ ] R052-13 Less friction around actions.
- [ ] R052-14 Model switching mid-chat that is instant and cheap.
- [ ] R052-15 One Chrome extension that signs in like a device.
- [ ] R052-16 Vault unlock in the extension.
- [ ] R052-17 Chrome control for chats.
- [ ] R052-18 Chat in the browser side panel.
- [ ] R052-19 Security review of the extension.

## 0.3.0
- [x] R030-01 One setup: reserve a name at vyre.run/setup, paste the code in the app, Join a team / Add a server / My Home.
- [x] R030-02 Pairing finishes every time; phones added from the computer.
- [x] R030-03 Mac mini as a server, Touch ID approves devices.
- [x] R030-04 Windows app with Windows Hello (DPAPI fallback).
- [x] R030-05 Security: added modules cannot reach another machine or name pairing/device tools (also in 0.2.13).
- [x] R030-06 Model switching mid-session without losing context.
- [x] R030-07 Pick a model per task (team.ask model).
- [x] R030-08 Flows that modules extend; late tasks escalate; law-firm kit.
- [x] R030-09 Connect anything from a Vault credential (quick form, check, generic request, Call a service, watchers, webhooks, import incl. YAML and URL).
- [x] R030-10 Modules feel built in: screens drawn by Vyre (list, detail, form, board, summary), pinned in the sidebar, module record types that survive upgrades, # mentions.
- [x] R030-11 A sidebar each person arranges; team default by owner/admin.
- [x] R030-12 The README gif real: activity feed, hand-off and report-back, grouped approval with every field shown, one Face ID (iPhone), Lumen conversation view, sent mail logged on the client, done notice.
- [x] R030-13 Chat: copy, find, keyboard, clean header, instant send, Ask another model.
- [x] R030-14 Always back online: Mac power settings, FileVault stop-and-ask, Linux back after reboot, offline notice for a paired server.
- [x] R030-15 One keychain prompt; update from Settings.
- [ ] R030-16 Documents, first part: e-signature installed on your own server, with Waiting for signature and Send for signature in Vyre.
- [ ] R030-17 Documents file themselves on the client: a Document record, a ready Flow filing a signature on the signer's client, Send for signature from a record.

## 0.3.1 (carried into 0.5)

The lines in 0.3.1 and 0.3.2 were built across the releases up to 0.5. Their ticks have not been updated line by line; the CHANGELOG is the record of what shipped.

**Projects, agents and templates**
- [ ] R031-01 One kind of Project, which is a record; template optional.
- [ ] R031-02 Free tags and relations on everything; a tag filter is a saved view pinnable in the sidebar.
- [ ] R031-03 Every chat belongs to a project; loose chats go to your private Personal project.
- [ ] R031-04 Project files encrypted at rest with a server-held key; only members, their assistants and working teammates open them; every agent read logged.
- [ ] R031-05 Your assistant holds a grant on your identity: your access by default, narrowed only by you; sealed data stays sealed.
- [ ] R031-06 Assistant, Agents (the space's roster), Teammates (an agent in a project), optional Project lead.
- [ ] R031-07 Subagents: short-lived helpers with their parent's permissions or fewer, nested in the activity feed.
- [ ] R031-08 Agent memory: skills and lessons travel with the agent; project facts stay in the project.
- [ ] R031-09 Every agent has an owner; agents change by conversation, owner approves, versioned, rollback.
- [ ] R031-10 Templates: stages with gates ("moves on when", who may move early), tasks with roles, auto-written task briefs (goal and done-check, context, what needs a yes, who to ask, checklist and standard, Vault credentials).
- [ ] R031-11 Template studio: tree of stages and tasks, Automations, Test mode, Go live, versioned; agents may propose template changes.
- [ ] R031-12 Templates from kits, from a finished project, from a description, from the studio.
- [ ] R031-13 A Flow step "start a project from a template".
- [ ] R031-14 Project pages: free-flow opens on chats with Files and Memory tabs; template projects open on a chosen or built screen.
- [ ] R031-15 Two or three panes side by side (chat, preview, files) on big screens.
- [ ] R031-16 @Engineer ships with every space and does all setup (templates, Flows, screens, connections, modules, skills) conversationally, through approve-and-version.
- [ ] R031-17 Vyre-native by default: every AI session (Claude, Codex, Grok) is taught Vyre's ways and reaches for them unprompted (records, Flows, previews, timeline, grouped approvals, skills).

**Skills and plugins**
- [ ] R031-18 One skills and plugins library at four levels (space, personal, agent, project), versioned with owners.
- [ ] R031-19 Install once, materialised per AI (Claude plugin dir, Codex skills dir, Grok).
- [ ] R031-20 Anyone drafts a skill; the level's owner approves.
- [ ] R031-21 Plugins with code need an owner's or admin's yes; hooks and scripts sandboxed and declared; their MCP servers become Connections.

**Previews**
- [ ] R031-22 Persistent localhost: a port an agent opens becomes a live preview card in its chat, supervised, surviving restarts.
- [ ] R031-23 Preview access: project members by default, Personal only you; one click to share with the team or make public.

**Flows: the beast (reliability core)**
- [ ] R031-24 Timeouts and retry policy on every step.
- [ ] R031-25 "If this fails" paths per step and per Flow.
- [ ] R031-26 VERIFY on every step: how the step proves it worked, optional or essential; @Engineer writes verifies and tests for each step.
- [ ] R031-27 Needs attention inbox with Retry from here, Skip, Stop, and a notice.
- [ ] R031-28 Resume from the failed step.
- [ ] R031-29 Stuck-run watchdog.
- [ ] R031-30 Concurrency limits and per-record locks.
- [ ] R031-31 Pause all, pause one, drain.
- [ ] R031-32 Health line per Flow; red when its Connection is red.
- [ ] R031-33 Version compare and one-click rollback.
- [ ] R031-34 Full run timeline (inputs, outputs, attempts, approvals; sealed values hidden).
- [ ] R031-35 Saved test cases; no go-live while one fails.
- [ ] R031-36 Explain this run, in plain words.
- [ ] R031-37 Compact Flow text that round-trips with the canvas; edit by patch; flows.describe; errors that name the place and fix; validate and simulate before propose; a schema cheat-sheet.
- [ ] R031-38 Stage gates, task checklists and template test mode run on the same runner.

**Cheap wins that tie things together**
- [ ] R031-39 "Chat about this" on any record or project.
- [ ] R031-40 Cited fields open their record.
- [ ] R031-41 "Link to Northwind?" in chat; private until shared.
- [ ] R031-42 "Turn this into a Flow" after hand-done work.
- [ ] R031-43 Connections list their Flows.
- [ ] R031-44 Lessons become skills (learn module and teammates).
- [ ] R031-45 One "Needs you" place (approvals, failed runs, stuck tasks).
- [ ] R031-46 One timeline per record and project; chats private until shared; the rest visible to those who can see that record type.
- [ ] R031-47 "What's new" after an update.
- [ ] R031-48 Pin anything in the sidebar.

**Carried from 0.3.0 cuts**
- [ ] R031-49 Add your own app modules on a server with one Touch ID/Face ID approval (root verifies against its own record of the owner).
- [ ] R031-50 Windows Home (Vyre running on a Windows PC, no server), first run offers My Home.
- [ ] R031-51 The agents-and-sessions view and app chat parity for hand-offs.
- [ ] R031-52 Android notices with the app closed (via the relay connection).
- [ ] R031-53 Chat: "Ask about this" on selected text; turn summary chip with a changes panel and Undo per file; paste or drop images and files proven with Claude, Codex and Grok.
- [ ] R031-54 Internal clean-up: old network code removed and every known failing check explained.
- [ ] R031-55 iPhone: one Face ID approves a batch, proven on a real device.

## 0.3.2
- [ ] R032-01 Documents: generate documents from your Word or Excel templates, filled from your records; if a value is missing, it says which one instead of guessing.
- [ ] R032-02 Documents: signing pages for people outside your team, on your workspace's address or your own domain, in your logo and colours.
- [ ] R032-03 Documents filed as Document records on client, project, template version and file (project files or Drive).
- [ ] R032-04 Comms: email (your mail Connection) and SMS (Twilio) delivery, logged on the client, held for a yes.
- [ ] R032-05 Signing from a stage done with Flows (stage event plus a Documents step).
- [ ] R032-06 Publish: GitHub sign-in, repo in your account or org, private or public; the server builds from the repo; served at <name>.<space>.vyre.run or your domain with one DNS record; every publish a version, one-tap rollback; static sites, apps with a server, scheduled jobs and APIs.
- [ ] R032-07 Publish from the preview card.
- [ ] R032-08 Flows: parallel branches and sub-flows.
- [ ] R032-09 Flows: schedules with time zone, business hours, holidays, catch-up rule.
- [ ] R032-10 Flows: try it on last week (replay real triggers in simulate).

## Later
- [ ] R04-01 A signing page designed entirely in Vyre's own look.
- [ ] R04-02 iPhone push and a non-sideloaded iPhone app (waits on the Apple Developer Team ID).
