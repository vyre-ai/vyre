---
title: Roadmap
summary: Where Vyre is going, line by line, with what each release contains.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Roadmap

This is direction, not a promise of dates. Each line has an ID; a line is ticked when it ships in a release. What is true today is in the [releases](https://github.com/vyre-ai/vyre/releases) and [known gaps](known-gaps.md).


## 0.3.0 (releasing now)
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

## 0.3.1 (next)

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
