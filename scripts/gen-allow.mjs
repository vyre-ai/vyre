#!/usr/bin/env node
// Generates kernel/golden/allow.json from core/modules/agent-reach.js (the OPEN and ASK_FIRST lists) and the flows manifest, so the allow file cannot disagree with them.
// Every entry names one tool and gives its own reason: what the tool does, so a reader can see why a person's assistant may call it. PERSON_ONLY tools never appear.
//   node scripts/gen-allow.mjs           write kernel/golden/allow.json
//   node scripts/gen-allow.mjs --check   exit 1 when the committed file differs from the generator's output
// A hand-written entry is not allowed: to name an exception, add the tool to a list here with a reason, or classify it in agent-reach.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN, ASK_FIRST, PERSON_ONLY } from "../core/modules/agent-reach.js";
import { toolEntries } from "../packages/module-sdk/manifest.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOW_FILE = path.join(REPO, "kernel", "golden", "allow.json");

const RULING = "user ruling 4 Oct 2026: an assistant can do what its person can";
const SAFE = "open to the person's assistant, safe only for a daemon-stamped session claim (L-1)";

/** What each OPEN tool does, in its own words. A tool in OPEN with no line here fails the generator, so a new open tool must say what it is. */
export const OPEN_NOTES = Object.freeze({
  "files.drive.upload": "puts a file in the Space drive under the caller's own chain; the kernel decides who may, and a version, never an overwrite",
  "files.drive.versions": "lists a drive file's versions the caller may read; the kernel decides",
  "records.me": "says who the caller is in the Space; no data",
  "records.actors": "lists the Space's people and assistants the caller may see; the kernel decides what shows",
  "records.types": "lists the record types; the kernel hides what the caller may not see",
  "records.list": "lists records under the caller's own chain; the kernel decides every row",
  "records.get": "reads one record under the caller's own chain; the kernel decides",
  "records.create": "writes a record under the caller's own chain; an assistant's chain is narrowed by the kernel and a sealed value goes through a placeholder",
  "records.update": "edits a record under the caller's own chain; the kernel decides",
  "records.seal-put": "puts a sealed value through the sealing process: the kernel and the sealer decide, never the module",
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
  "names.domain.check": "a live DNS check of the records for an own domain, a read",
  "network.funnel.status": "reads the state of the public share path on Tailscale Funnel",
  "network.guests.check": "reads who could reach the box as a guest now",
  "network.guests.list": "reads the guests from other tailnets the box serves and their tools",
  "planner.settings": "reads and sets the planner's zone and escalation timing, the person's own preferences",
  "presence.person.status": "reads whether this request is signed in as the person and until when",
  "projects.add-threads": "picks threads into a project; a thread can be in several projects",
  "projects.move": "moves a project's folders between homes on the box, leaving a link at each",
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
  "work.engineer.revise": "edits the Engineer's proposed definition, which is checked again and gets its own card",
  "work.engineer.talk": "talks to the Engineer, which only admins can do; explain reads a definition back",
  "work.team.add": "adds an assistant teammate from a Kit role, with grants that are narrowings of the adder's and never widen",
});

/** What each flows tool does, in its own words (the descriptions in core/flows/index.js). */
export const FLOWS_NOTES = Object.freeze({
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
});

const FLOWS_REASON = "the flows module authenticates the caller's chain, not an assistant's say-so: core/flows/index.js chainOf takes the chain from a daemon-bound session token or the person's own surface and refuses a plain mcp caller, an agent claim and anyone else, and the kernel authorizes every step under that chain";

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
  for (const tool of flowsAnyone()) {
    const note = /** @type {Record<string, string>} */ (FLOWS_NOTES)[tool];
    if (!note) throw new Error(`gen-allow: ${tool} is reach anyone in the flows manifest with no line in FLOWS_NOTES`);
    out.push({ tool, reason: `${RULING}; ${note}; ${FLOWS_REASON}` });
  }
  for (const e of out) if (PERSON_ONLY.has(e.tool)) throw new Error(`gen-allow: ${e.tool} is person only and must not be allowed`);
  const seen = new Set();
  for (const e of out) { if (seen.has(e.tool)) throw new Error(`gen-allow: ${e.tool} is listed twice`); seen.add(e.tool); }
  return out.sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

export const render = (/** @type {{ tool: string, reason: string }[]} */ entries) => JSON.stringify(entries, null, 1) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render(generate());
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = fs.readFileSync(ALLOW_FILE, "utf8"); } catch { /* none */ }
    if (have !== text) { console.error("kernel/golden/allow.json differs from the generator's output: run npm run golden:allow"); process.exit(1); }
  } else {
    fs.writeFileSync(ALLOW_FILE, text);
    console.log(`wrote ${ALLOW_FILE} (${generate().length} entries)`);
  }
}
