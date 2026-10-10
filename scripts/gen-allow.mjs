#!/usr/bin/env node
// Generates kernel/golden/allow.json from core/modules/agent-reach.js (the OPEN and ASK_FIRST lists) and the flows manifest, so the allow file cannot disagree with them.
// Every entry names one tool and gives its own reason: what the tool does, so a reader can see why a person's assistant may call it. PERSON_ONLY tools never appear.
//   node scripts/gen-allow.mjs           write kernel/golden/allow.json
//   node scripts/gen-allow.mjs --check   exit 1 when the committed file differs from the generator's output
//
// HOW DEVBOX REGENERATES (golden is a generated file; nobody hand-edits a row, and a hand-added row is replaced by the next regeneration): in each batch gate, on a test box after `npm ci` at the root,
//   1. node scripts/gen-allow.mjs                  rewrites kernel/golden/allow.json (OPEN, ASK_FIRST, DECLARED, flows and memory notes) and kernel/golden/presence.json (ruled presence removals); it throws, naming the tool,
//                                                  when a tool is classified with no note: add the note here (OPEN_NOTES, DECLARED_NOTES, FLOWS_NOTES, MEMORY_NOTES), never a hand-written row
//   2. node kernel/golden/index.js --write         re-records kernel/golden/golden.json from the code (about 7 minutes). It REFUSES, and says which cells, when a refusal turned into a run (a weakening: name it in
//                                                  the lists above or PRESENCE_RULINGS) or an added tool runs for a model, guest or MCP caller (classify it in core/modules/agent-reach.js or declare it here with its commit)
//   3. commit the three files together with the code that moved them; kernel/golden/allow.test.js and golden.test.js must then pass.
// A hand-written entry is not allowed: to name an exception, add the tool to a list here with a reason, or classify it in agent-reach.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN, ASK_FIRST, PERSON_ONLY } from "../core/modules/agent-reach.js";
import { toolEntries } from "../packages/module-sdk/manifest.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOW_FILE = path.join(REPO, "kernel", "golden", "allow.json");
export const PRESENCE_FILE = path.join(REPO, "kernel", "golden", "presence.json");

const RULING = "user ruling 4 Oct 2026: an assistant can do what its person can";
const SAFE = "open to the person's assistant, safe only for a daemon-stamped session claim (L-1)";

/** What each OPEN tool does, in its own words. A tool in OPEN with no line here fails the generator, so a new open tool must say what it is. */
export const OPEN_NOTES = Object.freeze({
  "update.whats-new": "reads the release notes of the version that is running, once per person; the assistant says them in the notes' own words",
  "update.whats-new-seen": "marks the release notes of the running version as seen by this person; the only thing written is that mark",
  "flows.settle": "answers a run that needs attention (retry, skip, stop, or move a stage gate on early) under the person's own chain; a stage gate moves only for its owner or an admin, with a reason on the ledger, and a value for a skipped step stays the person's",
  "flows.advance": "moves a record past its stage gate before the stage's tasks are done; only the stage's owner or an admin, in their own name, with a reason on the gate's ledger",
  "views.list": "lists the screens the installed modules declare; names and icons only, and what a screen shows is fetched later as the viewer",
  "views.get": "reads one screen a module declares; the data it shows is fetched as the viewer, under the viewer's own grants",
  "spaces.servers": "lists the person's own paired servers: names and addresses only, under the caller's own chain",
  "spaces.storage.get": "reads the caller's own per-member storage; the kernel's grants decide",
  "spaces.storage.list": "lists the caller's own per-member storage; the kernel's grants decide",
  "spaces.storage.usage": "reads how much of their own storage cap the caller uses",
  "connectors.declared": "a read of the connectors this build ships as declarations and whether a credential of each exists; callers are the person's surfaces, modules and a model, never a guest or an unknown caller (core/connectors/index.js)",
  "connectors.logging": "a read of the recipe for logging a mailbox or calendar to contacts, no data; callers are the person's surfaces, modules and a model, never a guest or an unknown caller (core/connectors/index.js)",
  "spaces.identity.devices": "lists the devices of a person you share a space with: id and key-agreement point only, public data, nothing for a stranger",
  "pluginagent.pending": "lists what Claude Code on a computer is waiting to be let do: a read, nothing is granted",
  "presence.person.locked": "lists the paired devices locked after wrong sign-in answers and when each lock ends: a read for the Devices list",
  "files.drive.space.list": "lists a Space drive folder the caller may read; the kernel decides",
  "files.drive.space.read": "reads a Space drive file the caller may read; the kernel decides",
  "records.linked": "lists the records linked to one, under the caller's own chain; the kernel decides each",
  "records.roles": "lists the role records that point at one contact, under the caller's own chain; the kernel checks each row",
  "records.holders": "lists the holders of one role, under the caller's own chain; the kernel checks each row",
  "records.kits.library": "lists the Kits the library offers: public text, no data",
  "records.kits.get": "reads one Kit's description from the library: public text, no data",
  "system.build": "reads the build this box runs: version and commit, no data",
  "files.drive.upload": "puts a file in the Space drive under the caller's own chain; the kernel decides who may, and a version, never an overwrite",
  "files.drive.versions": "lists a drive file's versions the caller may read; the kernel decides",
  "records.me": "says who the caller is in the Space; no data",
  "records.actors": "lists the Space's people and assistants the caller may see; the kernel decides what shows",
  "records.types": "lists the record types; the kernel hides what the caller may not see",
  "records.list": "lists records under the caller's own chain; the kernel decides every row",
  "records.get": "reads one record under the caller's own chain; the kernel decides",
  "records.reference": "reads one record under the caller's own chain with sealed parts as placeholders; the kernel decides",
  "records.create": "writes a record under the caller's own chain; an assistant's chain is narrowed by the kernel and a sealed value goes through a placeholder",
  "records.update": "edits a record under the caller's own chain; the kernel decides",
  "records.seal-put": "puts a sealed value through the sealing process: the kernel and the sealer decide, never the module",
  "records.forget.propose": "asks the person to forget a record: it reads the record under the caller's own chain and makes a task for the person, who decides with their presence; nothing is forgotten here",
  "records.sees-as": "shows what a person or an assistant would see of a record; reads only",
  "records.events": "reads events the caller may see; the kernel decides",
  "rules.list": "lists the Space's standing rules the caller may see",
  "rules.get": "reads one standing rule in plain words",
  "rules.test": "tries a rule against an act, without changing anything",
  "rules.propose": "proposes a rule: no effect until the owner accepts",
  "tasks.list": "lists tasks the caller may read; the kernel decides each",
  "tasks.get": "reads one task the caller may read",
  "tasks.request": "asks for a task under the caller's own chain; the kernel decides who may",
  "tasks.move": "starts, flags or skips a task; the kernel decides by the caller's role",
  "tasks.submit": "hands in a doer's work for a check; the kernel decides",
  "vault.provider.status": "returns which provider tokens are stored and when each was added, never a value; the person's own assistant chains only, and guests, anonymous, plain mcp and named agents without the grant stay refused",
  "artifacts.activity.log": "records that an interactive artifact navigated away, a log line for the Deck",
  "artifacts.mention.search": "the # picker's artifact titles, names and ids only",
  "bridges.get": "reads one share the person's Space is part of; the bridges module takes the person from the verified caller",
  "bridges.kit.plan": "lists what installing a Kit would add, applies nothing",
  "bridges.list": "reads the shares the person's Space is part of; the person comes from the verified caller",
  "bridges.merge.links": "one entry per Space the person belongs to, for a device that merges Spaces itself; a read",
  "bridges.propose-projection": "proposes sending chosen fields to another Space, which must accept first, so it is a proposal and nothing flows",
  "bridges.propose-reference": "proposes letting another Space show names of record types, an address and not access, which the other side accepts",
  "bridges.propose-view": "proposes a live read-only view to another Space, which the other side accepts before anything crosses",
  "chrome.plan.edit": "edits the words of a Chrome plan step that has not started; running and finished steps stay",
  "chrome.voice": "carries the person's live speech to the Chrome panel while an agent works",
  "computers.egress.status": "reads whether computers' Chrome sends listed sites through the person's Mac",
  "computers.handback.status": "reads after how many idle minutes a take-over hands the keyboard back",
  "computers.rename": "renames an agent's computer, the person's own label for it",
  "computers.tailnet.status": "reads whether computers join the tailnet as their own tagged nodes",
  "files.drive.address": "reads where one of the box's VyreDrive shares is reached on the tailnet",
  "files.drive.mount": "mounts one of the box's shares at ~/Vyre/Box on the person's Mac, a mount of what is already shared",
  "files.drive.open": "opens a mounted box share, or a file in it, in Finder",
  "files.drive.unmount": "unmounts a box share from the person's Mac",
  "files.drive.unshare": "stops sharing a folder over VyreDrive, which only takes access away",
  "files.mentions.search": "file names on the box's VyreDrive shares matching a # query, names only",
  "files.receive": "turns on or off whether the Mac takes in files the box delivers, the receive switch",
  "github.mcp.sync": "makes sure each connected GitHub account has GitHub's hosted MCP server in the hub, using a token already in the vault",
  "github.project": "makes a new project from a repo by cloning it into the projects folder",
  "github.project.add-repo": "adds a repo to an existing project as a new workspace folder, cloned fresh",
  "github.project.detect": "reads, per workspace folder, whether it is a git repo",
  "github.star": "stars vyre-ai/vyre with the person's connected GitHub account",
  "github.star.status": "reads whether the person has starred vyre-ai/vyre",
  "glass.close": "closes a Glass session",
  "glass.open": "opens a Glass target on a person's screen; the user ruled screen use is hands-free after one grant",
  "glass.release": "hands the keyboard of an agent's computer back to the agent",
  "glass.take": "takes the keyboard of an agent's computer; the user ruled screen use is hands-free after one grant, and the person's stop (hands.pause, chrome.pause) stays person-only",
  "glass.targets": "reads what Glass can open: each agent's computer and the box's files",
  "link.companion.list": "reads the companions and the waiting request",
  "link.rename": "renames a paired Mac or device, the person's own label",
  "mentions.kinds": "reads the kinds the # picker offers",
  "mentions.search": "names matching what was typed in the # picker, grouped by kind",
  "planner.settings": "reads and sets the planner's zone and escalation timing, the person's own preferences",
  "presence.person.status": "reads whether this request is signed in as the person and until when",
  "projects.add-threads": "picks threads into a project; a thread can be in several projects",
  "projects.remove-threads": "removes thread picks from a project; folder threads stay by folder",
  "projects.watchers.add": "adds names of people who hear about a project's needs",
  "projects.watchers.remove": "removes watchers from a project",
  "relay.devices.list": "reads the devices paired through the relay, their names and last seen",
  "relay.devices.path": "a paired device reports which way it reaches the box and its round trip",
  "relay.devices.rename": "renames a paired device, a label",
  "sessions.mention.search": "the @ picker's signed-in AI accounts by provider, names only",
  "spaces.assess-computer": "explains what keeping a Space on this computer means, a read",
  "spaces.compute.status": "reads what the Space and the person each said about running work on their computer",
  "spaces.get": "reads one Space: name, home, owners and warnings",
  "spaces.identity.contact.key": "makes a recovery contact's approval key for someone's identity; the private half stays on this device",
  "spaces.identity.entries": "reads who can speak for the person: devices, recovery code and contacts, flagging new sign-ins",
  "spaces.identity.resolve": "looks up a Vyre name by its exact name and verifies its list, a read",
  "spaces.identity.status": "reads this device's Vyre identity, name and place on the list, never a key",
  "spaces.identity.sync": "checks the directory for changes to the person's list and raises alerts, a read",
  "spaces.invites.list": "reads the invites the person made or may manage, never the link",
  "spaces.invites.preview": "shows what a join link offers before joining, a check of the link",
  "spaces.list": "reads the Spaces on this device and the person's role in each",
  "spaces.members.list": "reads everyone in a Space with role, scope, end date and warnings",
  "spaces.move.plan": "plans moving a Space to another home, ordered steps and checks, nothing moves",
  "spaces.roles.names": "reads the display names of the five roles, or renames one; the ids never change",
  "spaces.status": "reads where creating a Space has got to and why anything failed",
  "stream.keep": "keeps one answer of a fan-out set in a group chat; the others stay, quieter",
  "stream.mark-read": "moves the caller's read marker in a group chat session forward",
  "stream.open": "a one-use 15 second ticket for the session stream; the stream builds the caller's chain itself",
  "stream.pin": "pins or unpins a message in a group chat",
  "stream.react": "adds or takes back an emoji reaction on a group chat message",
  "stream.send": "says something in a group chat as the caller; the stream (core/stream/access.js) builds the chain and adds no people by a send",
  "system.rename": "renames this server's display name, a label and not the vyre.run address",
  "team.duties.run-now": "runs a duty once now, refused while it is off",
  "term.list": "reads the live terminals: folder, opener, size and bytes",
  "threads.branch": "starts a new thread from any point of a conversation",
  "threads.continue-here": "carries a paired Mac's session on in a new thread on this box",
  "threads.edit": "changes queued words before they are handed over",
  "threads.edit-retry": "edits and retries a message, rewinding the conversation to just before it",
  "threads.kill-task": "stops one of a thread's background tasks",
  "threads.remember": "adds a line to the project's or the person's CLAUDE.md",
  "threads.retry": "retries a message with the same words, idempotent with an idempotency key",
  "threads.unqueue": "takes back queued words before they are handed over",
  "vault.emergency.status": "reads where an emergency request to an owner stands",
  "voice.listen": "a one-use 30 second ticket for the voice listen socket",
  "voice.settings": "changes the speech provider, spoken replies or the voice; the key goes through the vault, never here",
  "voice.speak": "says a reply aloud through the speech provider",
  "voice.status": "reads the speech provider, whether its key is saved (never the key) and whether replies are spoken",
  "watchers.delete": "stops and forgets a watcher; a duty's folder goes, filed items stay",
  "watchers.resume": "resumes a paused watcher and clears its failure count",
  "watchers.run": "runs a turned-on watcher now and returns what happened",
  "wink.card": "builds the words card for an offer or grant, four lines and two buttons, a read",
  "wink.code.status": "reads the code that is showing now, if any",
  "wink.offers": "reads what is waiting on a person right now, with no secret",
  "wink.pair.status": "reads where a pairing is: waiting, confirm, done, failed or expired",
  "wink.storage.card": "builds the words a person reads before adding storage, no secret",
  "wink.storage.discover": "looks for drives this device can see, a read of the local network and disks",
  "wink.storage.offers": "reads the paired drives with room, use, data classes and end date",
  "wink.storage.status": "reads whether each storage device is there",
  "work.team.add": "adds an assistant teammate from a Kit role, with grants that are narrowings of the adder's and never widen",
});

/**
 * The tools a manifest declares reach `anyone` (or leaves open with `effect: "read"`) that opened to a model, a module or a guest cell of the golden set on 4 Oct 2026, with the commit
 * that did it. Each one's guard is the reason test/reach-anyone.json already holds for it (one source); a tool the reach file has no line for says its own in DECLARED_NOTES.
 * threads.delete and threads.rewind are not here: they are on ASK_FIRST (destructive), so they get their entry there.
 */
export const DECLARED = Object.freeze({
  // the 0.2.9 integration (lead, 6 Oct 2026): one chat, the chat upgrade, project reach and moves; each guard is its reach-anyone reason or its note below
  ...Object.fromEntries(["onboard.pair", "projects.access.pending", "projects.access.restore", "threads.chat-stop", "threads.chat-switch", "work.chat.change", "work.chat.create", "work.chat.get", "work.chat.history-import", "work.chat.list", "work.chat.move", "work.chat.rename", "work.chat.span", "work.chat.upgrade-move", "work.chat.upgrade-plan", "work.project.move-plan", "work.project.ref"].map(t => [t, "lead-0.2.9"])),
  ...Object.fromEntries(["agents.ask", "threads.archive", "threads.effort", "threads.fork", "threads.interrupt", "threads.model", "threads.send", "threads.send-now", "threads.start", "threads.stop",
    "threads.switch", "threads.thinking", "threads.unarchive", "threads.unwatch", "threads.watch"].map(t => [t, "06c2f3bcc"])),
  ...Object.fromEntries(["learn.add", "memory.curate", "memory.mute", "memory.pin", "team.charter.draft"].map(t => [t, "3b0ea63d2"])),
  ...Object.fromEntries(["apps.list", "apps.send", "apps.targets", "capsule.status", "hands.act", "hands.commit", "hands.find", "hands.observe", "hands.stop",
    "chrome.act", "chrome.api", "chrome.approve", "chrome.batch", "chrome.click", "chrome.console", "chrome.eval", "chrome.fill", "chrome.frames", "chrome.ghl", "chrome.inspect", "chrome.login",
    "chrome.net", "chrome.open", "chrome.parallel", "chrome.plan", "chrome.point", "chrome.recipe", "chrome.screenshot", "chrome.site", "chrome.snapshot", "chrome.sources", "chrome.state",
    "chrome.status", "chrome.stop", "chrome.summary", "chrome.tabs", "chrome.type", "chrome.wait"].map(t => [t, "cb69aea6d"])),
  ...Object.fromEntries(["threads.release", "github.accounts"].map(t => [t, "3c2ce3bcf"])),
  ...Object.fromEntries(["list", "get", "check", "export", "import", "propose"].map(t => [`connectors.connection.${t}`, "565e81d11"])),
  "vault.revoke": "59980bf43",
  "pluginagent.ask": "2bbe50159",
  "pluginagent.status": "2bbe50159",
  "link.pending": "235da322d",
  "harness.end": "c5e244c97",
  "threads.rename": "f990f0d36",
  "work.project.rename": "f990f0d36",
  "presence.remove": "235da322d",
  "planner.bin": "49f105dbe",
  "recall.links": "e8a4645fd",
  "recall.pointers": "e8a4645fd",
  "recall.turn": "e8a4645fd",
  // the 0.3.1 integration (main green): the agent's small always-loaded core (docs, skills, the module index), the app modules' read tools and the Connection tools; each guard is its reach-anyone reason
  "appmods.card": "428bfeb0b", "appmods.catalog": "428bfeb0b", "appmods.list": "428bfeb0b", "appmods.screens": "428bfeb0b", "appmods.status": "428bfeb0b", "appmods.connection": "ce0e2bacf", "appmods.hosts": "aaf71dbd9",
  "connectors.connection.check": "3e523101d", "connectors.connection.get": "3e523101d", "connectors.connection.list": "3e523101d", "connectors.connection.export": "498b073eb", "connectors.connection.import": "43f3ae8e1",
  "connectors.connection.propose": "565e81d11", "connectors.operation.run": "1d1318369",
  "docs.find": "92291f02c", "docs.read": "92291f02c", "skills.find": "08ccfca4c", "skills.get": "08ccfca4c", "skills.list": "08ccfca4c", "vyre.core": "cb8fd02ae",
});


/**
 * Tools opened to a model, a module or a person-labelled agent cell since the golden set was stored (9 Oct 2026), each with the commit that did it and its date. The guard is the tool's line in test/reach-anyone.json
 * (tried against the code by test/reach-anyone-behaviour.test.js) or its DECLARED_NOTES line. The registry's floor (lib/one-yes.js) still asks the person's yes in front of the moment tools; the golden recorder does not model the floor.
 */
export const DECLARED_SINCE = Object.freeze({
  "work.project.members": "a30768605@10 Oct 2026",
  "agents.spawn": "a2caa8817@9 Oct 2026",
  "agents.versions": "e1f5eebd7@9 Oct 2026",
  "appmods.domain.list": "cfa8ce91e@10 Oct 2026",
  "approvals.items": "aafc814ea@9 Oct 2026",
  "ask.get": "0db315762@3 Oct 2026",
  "ask.many": "3112254d5@10 Oct 2026",
  "brand.draft": "afde6d660@9 Oct 2026",
  "brand.get": "afde6d660@9 Oct 2026",
  "brand.resolve": "afde6d660@9 Oct 2026",
  "chrome.op": "c46135ba9@26 Sep 2026",
  "computer.targets": "9dcd44529@9 Oct 2026",
  "computer.use": "8b72edb5c@9 Oct 2026",
  "connectors.site.attention": "940faf738@10 Oct 2026",
  "connectors.site.limits": "8d813625d@9 Oct 2026",
  "connectors.site.list": "e0762c1c9@9 Oct 2026",
  "connectors.site.operations": "0a8df5c2b@9 Oct 2026",
  "connectors.site.propose": "0a96cfcfa@9 Oct 2026",
  "connectors.site.rows": "e0762c1c9@9 Oct 2026",
  "design.catalogue": "da28446d5@9 Oct 2026",
  "design.css": "afde6d660@9 Oct 2026",
  "design.css.propose": "afde6d660@9 Oct 2026",
  "design.propose": "da28446d5@9 Oct 2026",
  "design.screens": "da28446d5@9 Oct 2026",
  "design.validate": "da28446d5@9 Oct 2026",
  "documents.generate": "613f5aad8@10 Oct 2026",
  "documents.signed-link.revoke": "60d4a2c31@10 Oct 2026",
  "documents.signing.flow": "2f459afa0@10 Oct 2026",
  "documents.signing.waiting": "e9c422518@10 Oct 2026",
  "documents.template.add": "613f5aad8@10 Oct 2026",
  "documents.template.get": "613f5aad8@10 Oct 2026",
  "documents.template.list": "613f5aad8@10 Oct 2026",
  "memory.site.rollback": "b8e89c3ce@9 Oct 2026",
  "models.eval-queue": "4e3c1f397@9 Oct 2026",
  "models.evals": "4e3c1f397@9 Oct 2026",
  "models.get": "fb9855589@27 Sep 2026",
  "models.list": "4e3c1f397@9 Oct 2026",
  "models.refresh": "4e3c1f397@9 Oct 2026",
  "models.status": "4e3c1f397@9 Oct 2026",
  "names.domain.check": "08773e0e4@10 Oct 2026",
  "previews.get": "05a5ef8f4@30 Sep 2026",
  "previews.list": "73744ff3d@9 Oct 2026",
  "previews.open": "73744ff3d@9 Oct 2026",
  "previews.operator": "fe76a862a@10 Oct 2026",
  "previews.run-get": "fc01a560a@10 Oct 2026",
  "previews.signin": "fe76a862a@10 Oct 2026",
  "previews.signin-get": "fe76a862a@10 Oct 2026",
  "previews.step": "fe76a862a@10 Oct 2026",
  "publish.go": "cd3f9e63b@10 Oct 2026",
  "publish.quick": "cd3f9e63b@10 Oct 2026",
  "sessions.harness.get": "4e3c1f397@9 Oct 2026",
  "sidebar.pin": "2ee4e9077@9 Oct 2026",
  "sidebar.unpin": "2ee4e9077@9 Oct 2026",
  "skills.approve": "95132d453@9 Oct 2026",
  "skills.draft": "95132d453@9 Oct 2026",
  "skills.rollback": "95132d453@9 Oct 2026",
  "skills.versions": "95132d453@9 Oct 2026",
  "vault.agent.fill": "ddbf4e500@27 Sep 2026",
  "vault.agent.grant": "29f68e293@10 Oct 2026",
  "vault.delete": "29f68e293@10 Oct 2026",
  "vault.grant": "29f68e293@10 Oct 2026",
  "vault.health.summary": "bda28f976@10 Oct 2026",
  "vault.link": "b1efe5dd1@10 Oct 2026",
  "vault.links": "b1efe5dd1@10 Oct 2026",
  "vault.mcp.pass.list": "75159556c@9 Oct 2026",
  "vault.mcp.pass.revoke": "75159556c@9 Oct 2026",
  "vault.pass.accept": "29f68e293@10 Oct 2026",
  "vault.pending": "aafc814ea@10 Oct 2026",
  "vault.unlink": "b1efe5dd1@10 Oct 2026",
  "vault.used-by": "3bff38f14@10 Oct 2026",
  "views.show": "bc4f85ff0@9 Oct 2026",
  "work.chat.link": "021a571ef@10 Oct 2026",
  "work.chat.persistent": "4e3987561@9 Oct 2026",
  "work.chat.pin": "4e3987561@9 Oct 2026",
  "work.file.list": "4358bab9e@10 Oct 2026",
  "work.file.share": "3874b075a@10 Oct 2026",
  "work.file.unshare": "3874b075a@10 Oct 2026",
  "work.link.suggest": "021a571ef@10 Oct 2026",
  "work.start-project": "5d02ed44b@9 Oct 2026",
  "work.template.define": "5d02ed44b@9 Oct 2026",
  "work.template.from-project": "5d02ed44b@9 Oct 2026",
  "work.template.get": "5d02ed44b@9 Oct 2026",
  "work.template.install": "5d02ed44b@9 Oct 2026",
  "work.template.library": "5d02ed44b@9 Oct 2026",
  "work.template.list": "5d02ed44b@9 Oct 2026",
  "work.template.test": "5d02ed44b@9 Oct 2026",
  "work.timeline": "021a571ef@10 Oct 2026",
});

/** The guard of a DECLARED tool test/reach-anyone.json has no line for. */
export const DECLARED_NOTES = Object.freeze({
  "memory.site.rollback": "puts a learned website operation back to an earlier version; the body refuses everything but the person's own surfaces and Chrome's bridge (chrome() in core/memory/site.js)",
  "onboard.pair": "pairs a device while the box is being set up: the onboarding listener's own token and the person's surfaces; a cli label such as cli:agent:kit is the person's terminal, never a model (core/onboard/index.js)",
  "recall.turn": "a read of one past session's turns, word for word; callers are READERS and the body holds a model to its own project's sessions (reach() and readableSession in core/recall/index.js), the same guard as recall.search",
  "recall.links": "a read of the turns that touched a file, commit or url; callers are READERS and the body holds a model to its own project's folders (reach() and inFolders in core/recall/index.js), the same guard as recall.search",
  "recall.pointers": "the rollover split of a thread's own windows for Vyre's seed; callers are OWNERS_ONLY (core/recall/index.js), so a cli label such as agent:kit is the cli surface, not a model's session",
  "apps.list": "a read of the apps installed on this Mac; callers are the person's surfaces, modules and a model, never a guest or an unknown caller (local/apps/index.js)",
  "apps.targets": "a read of the notes and lists inside one app; callers are the person's surfaces, modules and a model, never a guest or an unknown caller (local/apps/index.js)",
  "apps.send": "sends as the person, so it is outward: held for the person's presence proof for every caller that is not a module",
  "capsule.status": "a read of whether the Capsule can run on this machine: build and autostart, no data; callers are the person's surfaces, modules and a model, never a guest or an unknown caller (local/capsule/index.js)",
  "learn.add": "a model's lesson is proposed and never made active; the person accepts it",
  "memory.curate": "admits a project agent under the module's own guard: its own project's memory only",
  "memory.mute": "admits a project agent under the module's own guard: its own project's memory only",
  "memory.pin": "admits a project agent under the module's own guard: its own project's memory only",
});

const DECLARED_REASONS = () => JSON.parse(fs.readFileSync(path.join(REPO, "test", "reach-anyone.json"), "utf8")).tools;

/** What each flows tool does, in its own words (the descriptions in core/flows/index.js). */
export const FLOWS_NOTES = Object.freeze({
  "flows.propose": "proposes a Flow for the person to approve: nothing runs, nothing is installed, until a person approves it",
  "flows.define": "writes a Flow as text or stored form, and nothing runs until a person approves it",
  "flows.card": "the approval card for a Flow version, a read",
  "flows.get": "reads one Flow version as stored",
  "flows.list": "lists the Flows of a Space",
  "flows.code": "reads a Flow as code",
  "flows.compile-text": "checks text as a Flow without storing it",
  "flows.graph": "reads a Flow as a graph for the canvas",
  "flows.simulate": "replays recent events through a Flow without doing anything",
  "flows.start": "starts a Flow now with an input, under the caller's chain, and an approved Flow only",
  "flows.runs": "lists the recent runs of a Flow",
  "flows.run": "reads one run: trigger, steps and what it did",
  "flows.retry": "retries a failed run under the caller's chain",
  "flows.kit.card": "the install card for a Kit, a read",
  "flows.kit.propose": "proposes a Kit for approval, and installing waits for a person",
  "flows.kit.list": "lists the Kits of a Space",
  "flows.kit.test": "walks a Kit on a sample or a record the caller can read, with every action stubbed: nothing is stored, sent or emitted",
  "flows.kit.diff": "reads what updating an installed Kit to a version would change: parts added, changed and removed, and the risks; nothing is changed",
  "flows.kit.library": "lists the Kits this build ships before anything is installed: public text, no data",
  "flows.kit.library.get": "reads one shipped Kit in the form the card, diff and propose tools take: public text, no data",
  "flows.cancel": "cancels one run under the caller's chain: the run stops at its next step boundary, and nothing already done is undone",
  "flows.control": "reads the Space's Flow control state: the concurrency limits, what is paused, what is queued and why; nothing is changed",
  "flows.health": "reads how a Flow is doing: runs, failures, handled failures and the slowest steps, with no step data",
  "flows.timeline": "reads a run as a timeline of its steps, with secrets hidden in what it shows",
  "flows.diff": "reads what changed between two versions of a Flow; nothing is changed",
  "flows.describe": "reads a Flow in plain words for a person: when it runs, what it does, what it can touch; nothing is changed",
  "flows.cheatsheet": "reads the Flows language as one page of public text, no data",
  "flows.patch": "stores a new draft version of a Flow from named edits, and nothing runs until a person approves it, as flows.define",
  "flows.test.save": "saves a test case for a Flow, which only makes approving it stricter; an assistant adds a case but never changes one, and a case that is saved is run once with every action stubbed",
  "flows.test.run": "runs the saved test cases of a Flow with every action stubbed: nothing is stored, sent or emitted",
  "flows.test.list": "reads the saved test cases of a Flow",
  "flows.from-chat": "stores a draft Flow from the calls an assistant made, as flows.define does; nothing runs until a person approves it",
  "flows.connections": "lists, per Connection, the Flows that use it with their health lines: names and levels, no data",
  "flows.attention": "lists the runs that need a person, in plain words with the message redacted; no step data",
  "flows.budget": "reads the Space's daily AI allowance for Flow steps and what is used today; setting it is an owner or an admin's, decided by the module from the caller's chain",
});

const FLOWS_REASON = "the flows module authenticates the caller's chain, not an assistant's say-so: core/flows/index.js chainOf takes the chain from a daemon-bound session token or the person's own surface and refuses a plain mcp caller, an agent claim and anyone else, and the kernel authorizes every step under that chain";

const MEMORY_REASON = "the memory module's own guard decides, not an assistant's say-so: the kernel's chain (core/memory/kernel-gate.js, personalAccess) and the kernel's memory grants decide, and a plain mcp, harness or guest call without a verified person or session is refused inside the tool";
/** The reach `anyone` memory tools a person's assistant may call, each with what it does and who decides. Everything else in the memory manifest is person only (agent-reach.js) or refused to a model by its callers list. */
export const MEMORY_NOTES = Object.freeze({
  "memory.follow": "follows a project or a room so its memory is brought in for the person; it only widens what the person's own memory shows them",
  "memory.markers": "reads the person's markers in a room, the places they marked in a conversation",
  "memory.identity.status": "says whether the person's identity memory is sealed here, unlocked, and which servers hold the person's grant: no fact and no key",
  "memory.identity.unlock.begin": "asks the person's phone to unlock the person's private memory for this server: nothing is readable until the phone answers, and only for a server the person granted",
  "memory.identity.lock": "locks the person's private memory now, which only takes access away: the latest facts are sealed and the rows leave the process",
  "memory.space.file": "files a fact in the Space's memory under the caller's own chain: the kernel's memory.file grant decides, and the fact's source must be one the filer may read",
  "memory.space.recall": "recalls the Space's facts the caller's chain may read: the kernel's memory.read grant is asked again for each fact",
  "memory.space.retire": "retires a Space fact under the caller's own chain: the kernel's memory.retire grant decides, the filer or a person with the right",
});

/** The memory tools allowed to a model, from MEMORY_NOTES, checked against the manifest. */
export function memoryAnyone() {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, "core", "memory", "module.json"), "utf8"));
  const have = new Set(toolEntries(m).map(e => e.name));
  return Object.keys(MEMORY_NOTES).filter(t => have.has(t)).sort();
}

/** The reach `anyone` tools of the flows manifest, which are not in agent-reach.js because they are not reach person. */
export function flowsAnyone() {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, "core", "flows", "module.json"), "utf8"));
  return toolEntries(m).filter(e => e.reach === "anyone").map(e => e.name).sort();
}

/** @returns {{ tool: string, reason: string }[]} */
export function generate() {
  /** @type {{ tool: string, reason: string }[]} */ const out = [];
  for (const tool of [...OPEN].sort()) {
    const note = /** @type {Record<string, string>} */ (OPEN_NOTES)[tool];
    if (!note) throw new Error(`gen-allow: ${tool} is in OPEN (core/modules/agent-reach.js) with no line in OPEN_NOTES`);
    out.push({ tool, reason: `${RULING}; ${SAFE}: ${note}` });
  }
  for (const [tool, why] of [...ASK_FIRST].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const note = /** @type {Record<string, string>} */ (OPEN_NOTES)[tool];
    out.push({ tool, reason: `${RULING}; open to the person's assistant but held for a one-tap task (${why})${note ? `: ${note}` : ""}` });
  }
  const reasons = DECLARED_REASONS();
  for (const [tool, ref] of Object.entries({ ...DECLARED, ...DECLARED_SINCE })) {
    const [commit, when = "4 Oct 2026"] = String(ref).split("@");
    const guard = /** @type {Record<string, string>} */ (DECLARED_NOTES)[tool] || (reasons[tool] && reasons[tool].reason);
    if (!guard) throw new Error(`gen-allow: ${tool} is in DECLARED with no guard in DECLARED_NOTES or test/reach-anyone.json`);
    out.push({ tool, reason: `${RULING}; ${tool} opened to a model or a module in ${commit} (${when}); the body decides: ${guard}` });
  }
  for (const tool of flowsAnyone()) {
    const note = /** @type {Record<string, string>} */ (FLOWS_NOTES)[tool];
    if (!note) throw new Error(`gen-allow: ${tool} is reach anyone in the flows manifest with no line in FLOWS_NOTES`);
    out.push({ tool, reason: `${RULING}; ${note}; ${FLOWS_REASON}` });
  }
  for (const tool of memoryAnyone()) out.push({ tool, reason: `${RULING}; ${MEMORY_NOTES[tool]}; ${MEMORY_REASON}` });
  for (const e of out) if (PERSON_ONLY.has(e.tool)) throw new Error(`gen-allow: ${e.tool} is person only and must not be allowed`);
  const seen = new Set();
  for (const e of out) { if (seen.has(e.tool)) throw new Error(`gen-allow: ${e.tool} is listed twice`); seen.add(e.tool); }
  return out.sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

export const render = (/** @type {any[]} */ entries) => JSON.stringify(entries, null, 1) + "\n";

/**
 * A PRESENCE the user ruled away from a tool (never a way to open a tool to a model: that is OPEN, ASK_FIRST and DECLARED above). The golden refresh refuses a cell that moves from refused to run; when the move is a ruled
 * removal of a fresh-proof requirement from a tool a PERSON does (a person-only tool, which allow.json never lists), it is named here: the tool, the one refusal it was (`was`, always presence_required), the person
 * callers it applies to (never a model, guest, MCP or harness caller), and the ruling that did it. kernel/golden/presence.json is generated from this list and read by the refresh beside allow.json.
 */
const ONE_YES = "team/ROADMAP.md R031-74, one yes at the floor (lib/one-yes.js, team/0.3.1/SPEC-one-yes-clients.md), and the user's no-nagging rule: a fresh proof only for pairing, vault secrets and outbound";
/** A ruled presence removal under the one-yes ruling: the cell it replaced (`was`), the person callers, and what the tool does now. */
const S = (/** @type {string} */ was, /** @type {readonly string[]} */ callers, /** @type {string} */ note) => Object.freeze({ ruling: ONE_YES, commit: "29f68e293", was, callers, note });
export const PRESENCE_RULINGS = Object.freeze({
  "spaces.host-here": Object.freeze({
    ruling: "team/0.2/CHAT.md 2026-10-05T04:15Z, the user: Touch ID stays only for making someone an owner and transferring ownership",
    commit: "11391dc9d",
    was: "presence_required",
    callers: Object.freeze(["cli", "local", "deck", "capsule", "mobile", "tailnet:owner", "device"]),
    note: "hosting a space on this server is the owner's own act as a person and no longer asks for a fresh proof",
  }),
  "appmods.remove": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "flows.approve": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "learn.skill-retire": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "names.domain.check": S("person_session_required", Object.freeze(["device", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "network.wink.leave": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "onboard.claude": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "onboard.finish": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "pluginagent.revoke": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "presence.person.renew-allow": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "recall.sealscrub": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "records.forget": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "relay.devices.remove": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "relay.disable": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.account.create": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.account.enroll-touchid": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.account.unlock": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.account.unlock-phone": S("presence_required", Object.freeze(["device"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.breach.check": S("presence_required", Object.freeze(["cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.codes": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.codes.import": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.connect": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.delete|person_session_required": S("person_session_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "its yes is asked once at the registry floor now, in front of the tool (its moment), not by a presence declaration the tool carries"),
  "vault.delete|presence_required": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "its yes is asked once at the registry floor now, in front of the tool (its moment), not by a presence declaration the tool carries"),
  "vault.edit": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.emergency.refresh": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.emergency.request": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.import.preview": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.members.accept": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.migrate-key": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.move": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.people.verify": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.person.add": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.provider.remove": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.provider.set": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.put": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.revert": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.rotate": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.ssh.add": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.sweep": S("presence_required", Object.freeze(["cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.unlock": S("presence_required", Object.freeze(["cli", "device", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.unlock-passphrase": S("presence_required", Object.freeze(["cli", "local"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "vault.update": S("presence_required", Object.freeze(["cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.code.redeem": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.offer.set": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.remove": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.share": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.storage.bridge.drive": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.storage.pair": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.storage.pick": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
  "wink.storage.remove": S("presence_required", Object.freeze(["capsule", "cli", "deck", "device", "local", "tailnet:owner"]), "no longer asks a fresh proof: the one yes covers the pair, vault and outward moments only (lib/one-yes.js MOMENT_OPS), and this tool is none of them"),
});

/**
 * A tool a PERSON does, newly open to the surfaces they use (the Deck, the Capsule, the phone and the paired computer): a cell that was `denied` because the tool listed other callers, now a person-surface caller
 * that still has to pass the tool's own presence floor. Narrow like a presence removal: one tool, the person callers, the one refusal it replaced, and the person's ruling. Never a model, guest, MCP or harness
 * caller. Written into kernel/golden/presence.json beside the presence rulings.
 */
export const SURFACE_RULINGS = Object.freeze({
  "vault.import": Object.freeze({
    ruling: "team/ROADMAP.md R031-66 and R031-67, 9 Oct 2026, the user's Vault picks: the import screen in the app and the keys found in projects",
    commit: "work/vault-ux-031",
    was: "denied",
    callers: Object.freeze(["deck", "capsule", "mobile", "tailnet:owner", "device"]),
    note: "the app imports the export a person picked (its bytes), or the .env files a scan found, into their own Vault; it asks the person's presence on that exact import, and an assistant still cannot pass bytes",
  }),
  "vault.import.preview": Object.freeze({
    ruling: "team/ROADMAP.md R031-66 and R031-67, 9 Oct 2026, the user's Vault picks: the import screen in the app and the keys found in projects",
    commit: "work/vault-ux-031",
    was: "denied",
    callers: Object.freeze(["deck", "capsule", "mobile", "tailnet:owner", "device"]),
    note: "the app previews the export a person picked, by name and count only, before it imports; it asks the person's presence",
  }),
  "vault.env.scan": Object.freeze({
    ruling: "team/ROADMAP.md R031-66 and R031-67, 9 Oct 2026, the user's Vault picks: the import screen in the app and the keys found in projects",
    commit: "work/vault-ux-031",
    was: "denied",
    callers: Object.freeze(["mobile"]),
    note: "the phone app lists the .env files in the person's projects that hold keys: names and counts, never a value",
  }),
  "vault.members.accept": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
  "vault.members.invite": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
  "vault.members.remove": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
  "vault.members.role": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
  "vault.vaults.create": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
  "vault.vaults.rotate": Object.freeze({ ruling: ONE_YES, commit: "86dad5619", was: "denied", callers: Object.freeze(["device"]), note: "a person on a paired device now does this too (shared vaults take the person's devices); it is a vault moment, so the one yes is asked at the registry floor" }),
});

/** @returns {{ tool: string, was: string, callers: string[], ruling: string, reason: string }[]} */
export function generatePresence() {
  const RISKY = /agent|^tailnet-guest|^mcp|^harness/;
  const person = (/** @type {string} */ tool, /** @type {any} */ r) => {
    if (!/(CHAT|ROADMAP)\.md/.test(r.ruling)) throw new Error(`gen-allow: ${tool}: a ruled change names its CHAT.md or ROADMAP.md ruling`);
    if (!r.callers.length || r.callers.some((/** @type {string} */ c) => RISKY.test(c))) throw new Error(`gen-allow: ${tool}: a ruled change names person callers only, never a model, guest, MCP or harness caller`);
    return { tool, was: r.was, callers: [...r.callers], ruling: r.ruling, reason: `${r.ruling}; ${tool} changed in ${r.commit}: ${r.note}` };
  };
  const presence = Object.entries(PRESENCE_RULINGS).map(([tool, r]) => {
    if (r.was !== "presence_required" && r.was !== "person_session_required") throw new Error(`gen-allow: ${tool}: a ruled presence removal is for a presence_required or person_session_required cell`);
    return person(tool.split("|")[0], r);
  });
  const surfaces = Object.entries(SURFACE_RULINGS).map(([tool, r]) => {
    if (r.was !== "denied") throw new Error(`gen-allow: ${tool}: a surface ruling is for a denied cell`);
    return person(tool, r);
  });
  return [...presence, ...surfaces].sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render(generate()), presence = render(generatePresence());
  if (process.argv.includes("--check")) {
    let have = "", havePresence = "";
    try { have = fs.readFileSync(ALLOW_FILE, "utf8"); } catch { /* none */ }
    try { havePresence = fs.readFileSync(PRESENCE_FILE, "utf8"); } catch { /* none */ }
    if (have !== text) { console.error("kernel/golden/allow.json differs from the generator's output: run npm run golden:allow"); process.exit(1); }
    if (havePresence !== presence) { console.error("kernel/golden/presence.json differs from the generator's output: run npm run golden:allow"); process.exit(1); }
  } else {
    fs.writeFileSync(ALLOW_FILE, text);
    fs.writeFileSync(PRESENCE_FILE, presence);
    console.log(`wrote ${ALLOW_FILE} (${generate().length} entries) and ${PRESENCE_FILE} (${generatePresence().length} entries)`);
  }
}
