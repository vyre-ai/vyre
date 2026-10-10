#!/usr/bin/env node
// gen-architecture-map: the three tables of docs/architecture/map.md that must never go stale, written from the tree.
//
//   node scripts/gen-architecture-map.mjs            write the tables into the page
//   node scripts/gen-architecture-map.mjs --check    exit 1 if the page's tables differ from the tree (writes nothing)
//
// The page is written by hand around three generated blocks, each between a pair of comment lines:
//   map:layout   every top-level folder of the repository
//   map:kernel   every folder of kernel/
//   map:modules  every module vyred loads (a folder with a module.json under core/, local/ or modules/), grouped by purpose
// What is generated is which things exist, and the module's roles and name, read from the manifest. What each thing is for is written below, once, in plain words. A folder or module
// that is not in these tables fails test/architecture-map.test.js, so adding one means saying here what it is: that is how the map stays true.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAGE = "docs/architecture/map.md";

/** Top-level folders of the repository and what each is. Hidden folders and node_modules are not listed. */
export const LAYOUT = {
  ".claude-plugin": "The Claude Code plugin marketplace entry that points at `harness/`.",
  ".github": "GitHub Actions workflows: tests, releases, the Windows and Mac proofs, the docs build.",
  apps: "The Vyre app (Expo, in `apps/app`): web, iPhone and Android from one codebase.",
  bin: "The `vyre` command's entry file and the git credential helper.",
  box: "The server's Docker image, its compose files and the `vyre` command that runs on the host.",
  core: "The daemon `vyred`: its plumbing and the core modules, one folder each.",
  "design-refs": "The picture tests' reference pictures for every block and key screen, made by CI in a pinned image (apps/app/scripts/design-pictures.mjs).",
  docs: "This documentation: concepts, how-to pages, the reference, the ADRs.",
  examples: "Example modules to copy from.",
  harness: "The Claude Code plugin: hooks, the MCP server, skills, commands, the status line.",
  kernel: "The trusted core: identity, grants, the event log, records, tasks, the sealing process. See the next section.",
  lib: "Shared pure code with no feature state: crypto boxes, identity helpers, the view engine, release signing.",
  local: "Modules that run on a person's own computer: Lumen (the Mac command bar), computer use, voice, the Windows app.",
  modules: "Optional first-party modules (computer use and Chrome for an agent's computer) and the vault's autofill extensions.",
  names: "The name directory (names.vyre.run), a Cloudflare Worker.",
  packages: "The module SDK: the manifest schema and its checker.",
  packaging: "Packaging for cloud images.",
  records: "The records language, Kits (starter sets of types and Flows) and connector declarations.",
  relay: "The relay that lets a paired device reach a server that has no open port: server, client library, web pages.",
  release: "Release data: the oldest version a release may update from, release notes.",
  scripts: "Installers, the docs build, the test and walk harnesses, evals.",
  site: "The public website at vyre.run.",
  spec: "The deep-link specification for the apps.",
  stores: "Record stores behind the kernel's store interface; today the Twenty store.",
  test: "Tests that cross folders: boundaries, docs, installers, releases.",
  tools: "Tooling for the Cloudflare workers.",
  web: "Static web assets.",
  wink: "The Go forwarder that carries Wink traffic, built into the server image.",
};

/** Folders of kernel/ and what each is. */
export const KERNEL = {
  audit: "Signed checkpoints of the event log, so a rollback or a split history is caught.",
  conformance: "The conformance suite every store, log and sealing process must pass.",
  contracts: "The shape of everything the kernel exchanges: types and frozen tables, no logic. Changes are additive only.",
  core: "The small core: the actor chain, authorize, the gate wrapper, events, presence, ids and URNs, fields, limits.",
  door: "The inference door: the one path a model call is meant to take, with scanning and sealed placeholders.",
  expr: "The expression language rules and Flows are written in.",
  flows: "The Flow runner: steps, triggers, stages, proposals, the code sandbox.",
  gateway: "The one API for records, events, grants and sealed uses, assembled from the parts below.",
  golden: "Pinned vectors that every implementation of the identity and event rules must reproduce.",
  grants: "Grants, members and the five roles, rebuilt from the log.",
  identity: "A person's identity: keys, the signed list of who speaks for them, recovery.",
  modules: "The sandbox that runs an added (not first-party) module in its own process.",
  placement: "Placing work on computers from signed descriptions; it decides where, never whether.",
  remote: "Calling another machine's kernel over Wink or the relay, with proofs.",
  retrofit: "Adapters that bring older features under the kernel's rules.",
  seal: "The sealing process: the only place sealed plaintext exists, and presence proofs are checked.",
  spaces: "One kernel per Space, and a handle to a Space this machine does not host.",
  storage: "A Space's Drive: encrypted chunks over local disk, S3 or a device.",
  store: "The record store interface and its in-memory, SQLite and sealed forms.",
  tasks: "Tasks and approvals: how work is given, checked and how anything asks a person.",
  tools: "The tool surface generated for a Space from its types and grants.",
};

/** The groups a module can be in, in reading order. */
export const GROUPS = [
  ["identity", "Identity, network and access", "Who you are, how machines find each other, and who may do what."],
  ["sessions", "Sessions and agents", "Claude Code and other sessions, the agents you name, and how they run."],
  ["work", "Work and records", "Projects, records, tasks, rules, Flows, files."],
  ["memory", "Memory and context", "What Vyre remembers and what it tells a session at its start."],
  ["outside", "Outside services", "Mail, Google, GitHub, webhooks, apps, computers and screens."],
  ["ui", "The app, settings and small helpers", "What the surfaces draw, and what keeps them informed."],
  ["system", "Running and updating Vyre", "Modules, updates, onboarding, spend, vitals."],
  ["mac", "On a person's computer", "Lumen and the Mac's hands, screen and voice."],
];

/** Every module folder: [group, what it is for]. The name and roles are read from module.json. */
export const MODULES = {
  "core/about": ["memory", "A few lines on who the user is, handed to every session at its start."],
  "core/agents": ["sessions", "The assistant and the agents a person makes."],
  "core/appearance": ["ui", "The theme, the colour scheme and the design tokens as settings."],
  "core/comms": ["outside", "One way to send a text or an email: it asks the Gate once, uses the person's own mail account or Twilio from the Vault, and logs it on the client."],
  "core/documents": ["work", "Word templates filled from records, PDFs, documents sent for signature and their signed copies filed on the client."],
  "core/appmods": ["outside", "Open-source apps (Documents first) run as containers on a server, from a pinned catalog."],
  "core/approvals": ["identity", "Approve on your phone: a paired phone signs a request's exact words."],
  "core/apps": ["system", "The Android app served from the server, signed with the owner's own key."],
  "core/artifacts": ["work", "Documents, pages, dashboards and small apps your agents make, kept on your server."],
  "core/assistant": ["sessions", "The assistant's own tools: a daily digest and triage."],
  "core/ask": ["sessions", "One card of several questions an agent asks a person at once, answered in the chat."],
  "core/attachments": ["sessions", "Files added to a chat message: stored once in the chat's folder, handed to the assistants as an image or a path."],
  "core/bridges": ["identity", "Sharing between Spaces on purpose: a shared view, a reference, a copy, a Kit."],
  "core/commands": ["ui", "Every command-line verb the running modules declare, as one list."],
  "core/computers": ["outside", "Each agent's own computer, a shared pool of screens, and take-over."],
  "core/connectors": ["outside", "The catalog of vendors that run their own MCP server, and connections a firm makes itself."],
  "core/context": ["memory", "Where the person is now: the project, folder, thread and app each surface last reported."],
  "core/docs": ["ui", "Find and read the docs from inside Vyre: docs.find and docs.read, with the agent docs offered only to agents."],
  "core/event-catalog": ["system", "Every event type the running modules may emit."],
  "core/files": ["work", "Find and bring over files on this machine and the server, inside folders the person chose."],
  "core/flows": ["work", "Flows and Kits: write, approve and run a Flow with its triggers, waits and tasks."],
  "core/gate": ["identity", "The outbound Gate: what an agent wants to send, spend or delete waits here for a person."],
  "core/github": ["outside", "Sign in with GitHub, repositories, a project from a repository."],
  "core/glass": ["outside", "Watch an agent's screen live and take it over."],
  "core/goals": ["work", "A goal and its ordered milestones, attached to a session or a project."],
  "core/google": ["outside", "Native Gmail and Google Calendar."],
  "core/harness": ["sessions", "What the Claude Code hooks ask vyred."],
  "core/hooks": ["outside", "Inbound webhooks from the public internet, each checked by the sender's signature."],
  "core/outside": ["outside", "Outside agents (Dots, Muse, ChatGPT): one address and token each, reading only what a person gave them, asking before any change."],
  "core/import": ["sessions", "Find this device's Claude Code sessions and import the ones you choose."],
  "core/learn": ["memory", "Vyre learns from corrections and enforces what it learned."],
  "core/link": ["identity", "Makes a Mac and a server one system: pairing, tools and events both ways."],
  "core/mail": ["outside", "One capability over every mail account the person connected."],
  "core/mcp": ["outside", "The hub for outside MCP servers; each is a sender at the Gate."],
  "core/memory": ["memory", "The memory graph and the curator."],
  "core/mentions": ["ui", "The # tag: one picker over everything a person may mention."],
  "core/modulelist": ["system", "The owner's reset of the accepted module list, for a deliberate downgrade."],
  "core/names": ["identity", "Your name on vyre.run: claiming it and publishing its address."],
  "core/network": ["identity", "The built-in network as the person sees it: signed in or not, and each link."],
  "core/onboard": ["system", "The first-run steps as tools the first screen calls."],
  "core/planner": ["work", "Alarms, timers, reminders, todos, notes and a calendar kept on the server."],
  "core/pluginagent": ["sessions", "Claude Code on a computer as a named agent the person grants once."],
  "core/previews": ["work", "A page or app an agent starts, opened in a pane beside the chat on its own address, kept running and shared on purpose."],
  "core/presence": ["identity", "Proving a person is there before a human-only act."],
  "core/projects": ["work", "Projects: the folders, repositories and sessions that belong together."],
  "core/providers": ["sessions", "Every session provider on this machine, with its accounts and models."],
  "core/publish": ["outside", "Put a site or app on the internet from your space: preview, approve, publish, go back."],
  "core/push": ["ui", "Notifications to a phone or laptop for the moments the person asked about."],
  "core/recall": ["memory", "Search over every turn of every session on this machine."],
  "core/records-tools": ["work", "The app's way into a Space's records: one tool per store call, under the caller's chain."],
  "core/relay": ["identity", "The way to reach a server that always works: it dials out to a relay and paired devices follow."],
  "core/rules-tools": ["work", "The app's way into a Space's standing rules."],
  "core/runner": ["sessions", "Runs a Space's AI sessions on a computer: sandboxed, in an encrypted workspace."],
  "core/sessions": ["sessions", "How the sessions Vyre starts run: drivers, status and system prompts."],
  "core/settings": ["ui", "One way to read and change every setting, at any level."],
  "core/sidebar": ["ui", "The sidebar each person arranges: built-in places, module screens, saved views."],
  "core/computer": ["outside", "Vyre Computer: one front door over the cloud computer, your Macs and the screen engines; computers by name, interface first, screen last."],
  "core/sight": ["outside", "One screen service for the Mac and every agent's computer: what is on it, what was just done."],
  "core/signin": ["identity", "`vyre signin`: the owner's phone approves a terminal."],
  "core/vyre-index": ["ui", "The live index of Vyre's modules for an agent with only the small tool core: vyre.core, from the map's table and the daemon's module list."],
  "core/skills": ["sessions", "Find the skills a session may use for what it is about to do: skills.find, skills.list, skills.get, cut by permission."],
  "core/spaces": ["identity", "Identity, Spaces, members and invites: the five roles, with temporary access."],
  "core/spend": ["system", "One ledger of what agents, sessions and memory spend, with a daily cap per provider."],
  "core/statusline": ["ui", "The one-line status under Claude Code."],
  "core/stream": ["sessions", "The session stream: what the switchboard's threads emit, for every surface."],
  "core/suggest": ["ui", "Predictive text for every surface: names after @, commands after /."],
  "core/switchboard": ["sessions", "Headless Claude Code sessions streamed to every surface, one keyboard at a time (the `threads` module)."],
  "core/sync": ["sessions", "A paired Mac or Windows PC sends its own session files to the server."],
  "core/system": ["system", "What this machine is running: version, role, host, memory, owner."],
  "core/tasks-tools": ["work", "The app's way into a Space's tasks."],
  "core/team": ["sessions", "Project teammates: a named, persistent agent per role per project."],
  "core/term": ["ui", "A terminal in the browser that survives like mosh."],
  "core/tips": ["ui", "One short tip at a time about the part of Vyre in use."],
  "core/undo": ["system", "The shared log of what agents and modules did, each with its inverse."],
  "core/update": ["system", "Is a newer Vyre out: one daily look and one answer every surface draws."],
  "core/vault": ["identity", "Credentials sealed at rest and released one item at a time."],
  "core/design": ["ui", "The design language's keeper: the block catalogue, the space's own screens, proposals to change them, and guarded custom CSS."],
  "core/brand": ["ui", "The space's brand profile (logo, colours, fonts, names, letterhead), the default for what the space makes."],
  "core/views": ["ui", "A module's screens, described by its manifest and drawn by Vyre."],
  "core/vitals": ["system", "How the server and this device are doing: CPU, memory, disk, battery."],
  "core/waiting": ["ui", "One list of what waits on the person: asks, held drafts, reminders, pairings."],
  "core/watchers": ["work", "The watcher runtime: small standing rules that react to events."],
  "core/wink": ["identity", "Pairing as grants: every way into a machine is a Wink."],
  "core/work": ["work", "The work layer on the kernel: the native assistant's tools, teammates and memory layers."],
  "local/apps": ["mac", "Drive the Mac's own apps: timers, notes, reminders."],
  "local/capsule": ["mac", "Lumen, the Mac command bar: press Control twice and talk."],
  "local/hands-chrome-mac": ["mac", "Deep control of your own Chrome through the Vyre extension."],
  "local/hands-mac": ["mac", "Computer use on macOS through the accessibility tree."],
  "local/screen-mac": ["mac", "Screen context on macOS: front app, window, URL, visible text."],
  "local/sideview": ["mac", "A session on the left and Chrome or Glass beside it, tiled."],
  "local/voice": ["mac", "Push-to-talk for Lumen with a speech provider."],
  "modules/hands-chrome": ["outside", "Chrome control for an agent's computer, over one long-lived connection."],
  "modules/hands-desktop": ["outside", "An agent's hands on a Linux desktop, through the accessibility tree."],
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dirs = (p) => fs.readdirSync(path.join(ROOT, p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/** Every top-level folder that is part of the repository (not .git, not node_modules). */
export const topLevelDirs = () => dirs(".").filter((d) => d !== ".git" && d !== "node_modules");
export const kernelDirs = () => dirs("kernel");
/** Every folder that holds a module.json under core/, local/ or modules/, with its manifest. */
export function moduleFolders() {
  const out = [];
  for (const t of ["core", "local", "modules"]) for (const d of dirs(t)) {
    const f = `${t}/${d}/module.json`;
    if (fs.existsSync(path.join(ROOT, f))) out.push({ folder: `${t}/${d}`, manifest: JSON.parse(read(f)) });
  }
  return out;
}

const roleWords = (m) => (Array.isArray(m.roles) && m.roles.length ? m.roles.join(" and ") : "box and local");
const cell = (s) => String(s).replace(/\|/g, "/");

export function layoutBlock() {
  const rows = topLevelDirs().map((d) => `| \`${d}/\` | ${cell(LAYOUT[d] || "(not described yet)")} |`);
  return ["| Folder | What it is |", "| --- | --- |", ...rows].join("\n");
}
export function kernelBlock() {
  const rows = kernelDirs().map((d) => `| \`kernel/${d}/\` | ${cell(KERNEL[d] || "(not described yet)")} |`);
  return ["| Folder | What it is |", "| --- | --- |", ...rows].join("\n");
}
export function modulesBlock() {
  const mods = moduleFolders();
  const parts = [];
  for (const [id, title, intro] of GROUPS) {
    const rows = mods.filter((m) => (MODULES[m.folder] || [])[0] === id).map((m) => `| \`${m.manifest.name}\` | \`${m.folder}/\` | ${roleWords(m.manifest)} | ${cell((MODULES[m.folder] || [, "(not described yet)"])[1])} |`);
    if (!rows.length) continue;
    parts.push(`### ${title}\n\n${intro}\n\n| Module | Folder | Runs on | What it does |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

const BLOCKS = { layout: layoutBlock, kernel: kernelBlock, modules: modulesBlock };
const marker = (n, end) => `<!-- map:${n}:${end ? "end" : "start"} -->`;

/** The page with each block between its markers replaced by what the tree says now. @param {string} text */
export function render(text) {
  let out = text;
  for (const [name, make] of Object.entries(BLOCKS)) {
    const a = out.indexOf(marker(name, false)), b = out.indexOf(marker(name, true));
    if (a < 0 || b < a) throw new Error(`${PAGE} has no ${marker(name, false)} ... ${marker(name, true)} pair`);
    out = `${out.slice(0, a + marker(name, false).length)}\n\n${make()}\n\n${out.slice(b)}`;
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("gen-architecture-map.mjs")) {
  const cur = read(PAGE), next = render(cur);
  if (process.argv.includes("--check")) {
    if (cur !== next) { console.error(`${PAGE} is out of date: run node scripts/gen-architecture-map.mjs`); process.exit(1); }
    console.log(`${PAGE} is current`);
  } else if (cur !== next) { fs.writeFileSync(path.join(ROOT, PAGE), next); console.log(`${PAGE} written`); } else console.log(`${PAGE} already current`);
}
