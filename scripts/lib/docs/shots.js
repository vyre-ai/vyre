// @ts-check
// shots: the docs' screenshots. What each one is (SHOTS, which scripts/docs-shots takes), the
// record of what each shot depicts (docs/shots.json), and the docs-check rule that holds the two
// together.
//
// A shot names the source files it `shows`. When it is taken, docs/shots.json records a sha256
// of each of those files' contents. A shot is older than the code it shows when any of those
// files has changed since: that is a content hash on purpose, not an mtime or a git date, because
// the checkout the shots are taken in (testbox, synced with rsync) has no .git and no mtimes
// worth trusting.
//
// The docs-check kind `shots`:
//   - a shot whose `shows` files changed (or went away) since it was taken
//   - a PNG under a docs/**/shots/ folder that docs/shots.json does not list
//   - a docs/shots.json entry whose PNG is gone
// A page that links a shot that does not exist is a `links` problem, found by check.js.
//
// Each entry of SHOTS:
//   name     the file name: <dir>/shots/<name>.png, and <name>.dark.png for the dark theme
//   dir      the docs folder the page lives in (get-started, using, ...)
//   world    which sample world renders it: deck (the Deck, from deck/test/world.js), onboard
//            (a fresh box in its onboarding, with fake tailscale and claude), fresh (that same box's
//            Deck once its setup is finished, with no assistant yet), glass (a box with
//            a folder of sample files open to Glass)
//   url      the route to open (deck), or the onboarding step (#you ... #devices)
//   width, height   the CSS viewport; the PNG is twice that (device scale 2). height "fit" grows
//            the viewport until the Deck's view no longer scrolls, up to maxHeight.
//   phone    true: a phone-sized touch viewport
//   themes   ["light", "dark"], or ["dark"] for a surface with one look (onboarding)
//   script   JavaScript run in the page before the shot, as the body of an async function with
//            wait(ms), until(expr, ms), click(selector), type(selector, text) and go(path)
//   clip     a CSS selector: crop to that element (plus pad pixels) instead of the viewport
//   shows    repository files the shot depicts; a change to any of them makes it stale
//   needs    files that must exist for the shot to be taken at all (a surface on another branch)
//   setup    "pair": alex's Mac, alex-mbp, asks to pair with the box just before the shot
//   alt, page, heading   the alt text, and where the shot belongs, for whoever places it

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST = "docs/shots.json";
export const RERUN = "run npm run docs:shots on testbox";

const DECK = ["deck/css/deck.css", "deck/js/app.js", "deck/index.html"];
const NOW = ["deck/views/now.js", "deck/css/views/now.css", "deck/js/needs.js"];
const PAIR = ["deck/js/pair.js", "deck/css/pair.css", "core/link/box.js"];
const PHONE = ["deck/js/phone-setup.js", "deck/css/views/phone-setup.css"];
const ONBOARD = ["deck/onboard/onboard.js", "deck/onboard/onboard.css", "deck/onboard/index.html", "deck/css/deck.css", "core/onboard/index.js"];
const BOTH = ["light", "dark"];

// Page scripts. The held email is the gate item sent via "mail"; its id is new every run.
const HELD_EMAIL = `const r = await (await fetch("/v1/tools/gate.held", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const d = (r.data || []).find(x => x.via === "mail") || (r.data || [])[0];
  if (!d) throw new Error("nothing held at the Gate");
  go("/needs/" + encodeURIComponent(d.id));
  // A phone opens the item as a sheet over Now (deck/views/needs.js, deck/js/need-sheet.js).
  await until('document.querySelector(".nsh-title") || (document.querySelector(".view") && /dana@harlowlegal/i.test(document.querySelector(".view").innerText))');
  await wait(800);`;
const SEARCH = `const s = document.querySelector("header input[type=search], header input");
  s.spellcheck = false; s.focus(); s.value = "harlow intake"; s.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(1500);`;

/** @type {any[]} */
export const SHOTS = [
  // ---- Onboarding: a fresh box, one screen per step ----
  { name: "onboarding-you", dir: "get-started", world: "onboard", url: "#you", width: 1280, height: 800, themes: ["dark"], shows: ONBOARD,
    script: `type("#name", "alex"); type("#assistant", "Juno"); await until('!document.querySelector("#primary").disabled');`,
    alt: "Step 1 of the onboarding: your name and your assistant's name, with the note that the address will be on your tailnet.",
    page: "get-started/onboarding.md", heading: "1. You" },
  { name: "onboarding-claude", dir: "get-started", world: "onboard", url: "#claude", width: 1280, height: 800, themes: ["dark"], shows: ONBOARD,
    script: `await until('document.querySelector(".choice")');`,
    alt: "Step 2: Claude Code is found on the machine, and Vyre offers to sign in with your Claude subscription or an API key.",
    page: "get-started/onboarding.md", heading: "2. Claude Code" },
  { name: "onboarding-tailscale", dir: "get-started", world: "onboard", url: "#tailscale", width: 1280, height: 800, themes: ["dark"], shows: [...ONBOARD, "core/names/tailscale.js"],
    script: `await until('document.querySelector("#primary")');
      if (/connect/i.test(document.querySelector("#primary").innerText)) click("#primary");
      await until('/continue/i.test(document.querySelector("#primary").innerText)', 20000);`,
    alt: "Step 3: the machine has joined the tailnet as alex-box, with each sign-in step ticked.",
    page: "get-started/onboarding.md", heading: "3. Tailscale" },
  { name: "onboarding-name", dir: "get-started", world: "onboard", url: "#name", width: 1280, height: 800, themes: ["dark"], shows: [...ONBOARD, "core/names/service.js"],
    script: `await until('document.querySelector("#primary")'); click("#primary");
      await until('document.querySelector("#primary") && /switch to/i.test(document.querySelector("#primary").innerText)', 30000);`,
    alt: "Step 4: the address https://alex-box.tail0000.ts.net is reserved, pointed at the machine and has its certificate.",
    page: "get-started/onboarding.md", heading: "4. Your address" },
  { name: "onboarding-history", dir: "get-started", world: "onboard", url: "#history", width: 1280, height: 800, themes: ["dark"], shows: ONBOARD,
    // The step lists the folders it found, "N sessions" each; the sample world's transcripts live in a temp folder, whose path must not
    // be in a picture, so it is written as a folder in the sample person's own Claude Code folder (keeping its last segment, so rows stay different) before the shot.
    script: `await until('/[0-9]+ sessions?/.test(document.body.innerText) && !document.querySelector(".bar.moving")', 20000);
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const bad = []; while (w.nextNode()) bad.push(w.currentNode);
      for (const n of bad) n.textContent = n.textContent.replace(/\\/(?:private\\/)?(?:tmp|var\\/folders)\\/[^\\s|]*/g, m => "/home/alex/.claude/projects/" + (m.replace(/\\/+$/, "").split("/").pop() || "sessions")).replace(/a temporary folder/g, "Claude Code");
      await wait(800);`,
    alt: "Step 5: Vyre has read the Claude Code sessions on the machine and offers to group them into first projects.",
    page: "get-started/onboarding.md", heading: "5. Your history" },
  { name: "onboarding-devices", dir: "get-started", world: "onboard", url: "#devices", width: 1280, height: "fit", maxHeight: 1300, themes: ["dark"], shows: [...ONBOARD, ...PAIR],
    script: `await until('document.querySelector(".pair-list") && document.querySelector(".pair-list").children.length', 15000); await wait(800);`,
    fit: ".ob-main",
    alt: "Step 6: the Pair this Mac card with alex-mbp asking to pair and a field for its code, and the Open Vyre on your phone card with a code for Tailscale and one for this box's address.",
    page: "get-started/onboarding.md", heading: "6. Your devices" },
  { name: "onboarding-ready", dir: "get-started", world: "onboard", url: "#ready", width: 1280, height: 800, themes: ["dark"], shows: ONBOARD,
    alt: "The last screen of the setup: Vyre is ready, with your Mac, your phone and your history ticked or still to do, and Open Vyre.",
    page: "get-started/onboarding.md", heading: "The last screen" },

  // ---- The Deck ----
  { name: "deck-now", dir: "using", world: "deck", url: "/now", width: 1280, height: 900, themes: BOTH,
    shows: [...DECK, ...NOW],
    alt: "Now in the Deck: two things wait for you, an email to Dana at Harlow Legal and a spend for Northwind Bakery, both held at the Gate.",
    page: "using/deck.md", heading: "What is on each view" },
  { name: "deck-held", dir: "using", world: "deck", url: "/now", width: 1280, height: "fit", maxHeight: 1100, themes: BOTH, script: HELD_EMAIL,
    shows: [...DECK, "deck/views/needs.js", "deck/css/views/needs.css", "deck/js/needs.js"],
    alt: "A held email opened in the Deck: who it goes to, why it stopped, the draft you can edit, and Send or Discard.",
    page: "using/deck.md", heading: "Approve or change a held draft" },
  { name: "deck-search", dir: "using", world: "deck", url: "/now", width: 1280, height: 720, themes: BOTH, script: SEARCH,
    shows: [...DECK],
    alt: "The Deck's search finding the Harlow intake session by what was said in it.",
    page: "using/deck.md", heading: "Search what was said" },
  { name: "deck-projects", dir: "using", world: "deck", url: "/projects", width: 1280, height: 480, themes: BOTH,
    shows: [...DECK, "deck/views/projects.js", "deck/css/views/projects.css"],
    alt: "Projects in the Deck: Northwind Bakery and Harlow Legal, each with its person and thread count.",
    page: "using/projects-and-threads.md", heading: "Make a project" },
  { name: "deck-project", dir: "using", world: "deck", url: "/projects/harlow-legal", width: 1280, height: "fit", maxHeight: 1200, themes: BOTH,
    shows: [...DECK, "deck/views/projects.js", "deck/css/views/projects.css"],
    alt: "The Harlow Legal project: its threads, the open one with a box to carry it on, and the brief every new thread is told.",
    page: "using/projects-and-threads.md", heading: "See a project and its brief" },
  { name: "deck-memory", dir: "using", world: "deck", url: "/memory", width: 1280, height: "fit", maxHeight: 1200, themes: BOTH,
    shows: [...DECK, "deck/views/memory.js", "deck/views/memory-data.js", "deck/views/memory-map.js", "deck/css/views/memory.css"],
    alt: "Memory in the Deck as a map: Sam Okafor and Dana Reyes, their projects and the facts linking them.",
    page: "using/memory.md", heading: "See what memory holds" },
  { name: "deck-agents", dir: "using", world: "deck", url: "/agents", width: 1280, height: 440, themes: BOTH,
    shows: [...DECK, "deck/views/agents.js", "deck/css/views/agents.css"],
    alt: "Agents in the Deck: juno, the assistant on every project, and kit on Harlow Legal and Northwind Bakery.",
    page: "using/agents.md", heading: "See what agents are doing and what they cost" },
  { name: "deck-agent", dir: "using", world: "deck", url: "/agents/kit", width: 1280, height: 860, themes: BOTH,
    // The job, talk, watchers, usage and model column; the computer panel beside it has no
    // computer to describe in the sample world (no computer driver on the box that takes it).
    clip: { x: 216, y: 48, width: 636, height: 760 },
    shows: [...DECK, "deck/views/agents.js", "deck/css/views/agents.css"],
    alt: "kit's page in the Deck: its job, its projects, a box to talk to it, what wakes it, its usage and its model.",
    page: "using/deck.md", heading: "Look after an agent" },
  { name: "deck-chat", dir: "using", world: "deck", url: "/chat", width: 1280, height: 640, themes: BOTH,
    shows: [...DECK, "deck/views/chat.js", "deck/chat/index.js", "deck/chat/nav.js", "deck/chat/chat.css", "deck/css/views/chat.css"],
    alt: "Chat in the Deck: recent sessions with their projects, and every session by project in the rail.",
    page: "using/chat.md", heading: "Find a session" },
  { name: "deck-vault", dir: "using", world: "deck", url: "/vault", width: 1280, height: 900, themes: BOTH,
    shows: [...DECK, "deck/views/vault.js", "deck/vault/model.js", "deck/css/views/vault.css"],
    alt: "The Vault in the Deck: a login, an API key, a card, a note, a secret and an env set, listed by name with no values shown.",
    page: "using/vault.md", heading: "See what you have" },
  { name: "deck-vault-item", dir: "using", world: "deck", url: "/vault?item=harlow-gmail", width: 1280, height: 900, themes: BOTH,
    shows: [...DECK, "deck/views/vault.js", "deck/views/vault-item.js", "deck/vault/model.js", "deck/css/views/vault.css"],
    alt: "One Vault item, harlow-gmail: its fields sealed until you reveal or copy them, who holds it and its history.",
    page: "using/vault.md", heading: "Show, copy or fill a value yourself" },
  { name: "deck-settings", dir: "using", world: "deck", url: "/settings", width: 1280, height: 1000, themes: BOTH,
    shows: [...DECK, "deck/views/settings.js", "deck/css/views/settings.css"],
    alt: "Settings in the Deck: the six setup steps, each with the vyre command that finishes it, then you and your address.",
    page: "using/deck.md", heading: "Finish setup, or change it" },
  { name: "settings-connections", dir: "using", world: "deck", url: "/settings#connections", width: 1280, height: 1000, themes: BOTH,
    script: `await until('/harlow-docs/.test(document.querySelector("#connections") && document.querySelector("#connections").parentElement.innerText)', 15000); await wait(800);`,
    shows: [...DECK, "deck/views/settings.js", "deck/views/connections.js", "deck/css/views/settings.css", "deck/css/views/connections.css"],
    alt: "Settings, Connections: the harlow-docs MCP server with its tools and the projects it serves, and Harlow Legal's Google account, each with Test and Remove, and the buttons to add more.",
    page: "using/connectors.md", heading: "Add an MCP server" },
  { name: "glass-files", dir: "using", world: "glass", url: "/glass/box", width: 1280, height: 640, themes: BOTH,
    script: `const open = async name => {
        const el = await until('[...document.querySelectorAll(".view *")].find(e => !e.children.length && e.textContent.trim() === ' + JSON.stringify(name) + ')');
        el.click(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await wait(1200);
      };
      await open("Work"); await open("Q3 report.md");`,
    shows: [...DECK, "deck/views/glass.js", "deck/glass/index.js", "deck/glass/files.js", "deck/glass/glass.css"],
    alt: "Glass on the box: the Work folder's files, with Q3 report.md open beside the list to download, rename or trash.",
    page: "using/glass.md", heading: "Browse and move files" },

  // ---- The Deck on a phone ----
  { name: "phone-now", dir: "using", world: "deck", url: "/now", width: 390, height: 844, phone: true, themes: BOTH,
    shows: [...DECK, ...NOW, ...PHONE],
    alt: "Now on a phone: the Set up this phone card (Home Screen, notifications, a passkey), what needs you, and the tab bar with Now, Projects, Chat, Find and Agents.",
    page: "using/mobile.md", heading: "Set up the phone" },
  { name: "phone-held", dir: "using", world: "deck", url: "/now", width: 390, height: 844, phone: true, themes: BOTH, script: HELD_EMAIL,
    shows: [...DECK, "deck/views/needs.js", "deck/css/views/needs.css", "deck/js/needs.js"],
    alt: "A held email on a phone, with Send and Discard in reach of your thumb.",
    page: "using/mobile.md", heading: "Approving from the phone" },

  { name: "phone-find", dir: "using", world: "deck", url: "/find", width: 390, height: 844, phone: true, themes: BOTH,
    script: `const i = await until('document.querySelector(".view input")'); i.spellcheck = false; i.focus(); i.value = "harlow"; i.dispatchEvent(new Event("input", { bubbles: true })); await wait(1800); i.blur();`,
    shows: [...DECK, "deck/views/find.js", "deck/css/views/find.css", "deck/js/commands.js"],
    alt: "Find on a phone with harlow typed: ask juno first, then the Harlow sessions, and the projects that match.",
    page: "using/mobile.md", heading: "What you can do from the phone" },

  { name: "settings-devices", dir: "using", world: "deck", url: "/settings#devices", width: 1280, height: 800, themes: BOTH,
    script: `await until('/alex-iphone/.test(document.body.innerText)', 15000); await wait(600);`,
    shows: [...DECK, "deck/views/settings.js", "deck/css/views/settings.css", "core/onboard/index.js"],
    alt: "Settings, Your devices: the iPhone alex-iphone, offline in Tailscale with how to turn it back on, and the Mac alex-mbp online, with Add a device.",
    page: "using/deck.md", heading: "Finish setup, or change it" },

  // ---- The Deck of a box whose setup just finished ----
  { name: "deck-new-box", dir: "using", world: "fresh", url: "/now", width: 1280, height: 900, themes: BOTH, setup: "pair",
    script: `await until('document.querySelector(".asst-title")', 15000); await wait(800);`,
    shows: [...DECK, ...NOW, ...PAIR, "deck/js/assistant-setup.js"],
    alt: "Now on a box whose setup just finished: the Create your assistant card, and the Mac alex-mbp asking to pair.",
    page: "using/agents.md", heading: "Make the assistant later" },
  { name: "deck-pair", dir: "using", world: "fresh", url: "/now", width: 1280, height: 900, themes: BOTH, setup: "pair", clip: ".pair-list", pad: 16,
    script: `await until('document.querySelector(".pair-list") && document.querySelector(".pair-list").children.length', 15000); await wait(600);`,
    shows: [...DECK, ...NOW, ...PAIR],
    alt: "The card on Now when a Mac asks to pair: alex-mbp, a field for the code the Mac shows, Approve and Deny.",
    page: "using/tailscale.md", heading: "Connect your Mac to the box" },
];

/** CLI output is shown as text, not pictures: these are the commands docs-shots --cli prints from the sample world. */
export const CLI = [
  { args: ["status"], page: "using/cli.md", heading: "Start Vyre and check on it" },
  { args: ["projects"], page: "using/cli.md", heading: "Open your projects" },
  { args: ["open", "harlow-legal"], page: "using/projects-and-threads.md", heading: "See a project and its brief" },
  { args: ["recall", "harlow intake"], page: "using/cli.md", heading: "Find something you said" },
  { args: ["agents"], page: "using/agents.md", heading: "See what agents are doing and what they cost" },
  { args: ["vault", "list"], page: "using/vault.md", heading: "See what you have" },
];

/** The PNG files a shot makes, repo-relative. */
export function filesOf(shot) {
  const base = `docs/${shot.dir}/shots/${shot.name}`;
  return (shot.themes || BOTH).map(t => (t === "dark" && (shot.themes || BOTH).length > 1 ? `${base}.dark.png` : `${base}.png`));
}

/** sha256 of one file's contents, or null when it is not there. */
export function hashFile(root, rel) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex"); } catch { return null; }
}

/**
 * The shots.json entry for a shot file: each `shows` file's hash, sorted, and one sha256 over
 * those (path and hash per line), which is what "unchanged" means.
 * @param {string} root @param {string[]} shows
 */
export function entryFor(root, shows) {
  /** @type {Record<string, string>} */ const files = {};
  for (const f of [...new Set(shows)].sort()) {
    const h = hashFile(root, f);
    if (!h) throw new Error(`a shot shows ${f}, which does not exist`);
    files[f] = h;
  }
  return { sha256: combined(files), shows: files };
}

const combined = files => crypto.createHash("sha256").update(Object.entries(files).map(([f, h]) => `${f} ${h}\n`).join("")).digest("hex");

/** docs/shots.json, read; {} when missing. Throws on bad JSON. */
export function readManifest(root) {
  const p = path.join(root, MANIFEST);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** docs/shots.json's text for a manifest: keys sorted, so the same shots write the same bytes. */
export function manifestText(m) {
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = { sha256: m[k].sha256, shows: Object.fromEntries(Object.entries(m[k].shows || {}).sort(([a], [b]) => (a < b ? -1 : 1))) };
  return JSON.stringify(out, null, 2) + "\n";
}

/** Every PNG under a shots/ folder in docs/, repo-relative, sorted. */
export function shotFiles(root) {
  const out = [];
  const walk = rel => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.png$/i.test(e.name) && r.split("/").slice(0, -1).includes("shots")) out.push(r);
    }
  };
  walk("docs");
  return out.sort();
}

/**
 * The `shots` kind of docs-check.
 * @param {{ root: string }} opts
 * @returns {{ file: string, line: number, kind: string, problem: string }[]}
 */
export function checkShots({ root }) {
  const problems = [];
  const add = (file, line, problem) => problems.push({ file, line, kind: "shots", problem });
  let text = "", m = {};
  try { text = fs.existsSync(path.join(root, MANIFEST)) ? fs.readFileSync(path.join(root, MANIFEST), "utf8") : ""; m = text ? JSON.parse(text) : {}; }
  catch (e) { add(MANIFEST, 1, `unreadable: ${/** @type {Error} */ (e).message}`); return problems; }
  const lineOf = key => { const i = text.indexOf(JSON.stringify(key)); return i < 0 ? 1 : text.slice(0, i).split("\n").length; };
  for (const [file, e] of Object.entries(m)) {
    if (!fs.existsSync(path.join(root, file))) { add(MANIFEST, lineOf(file), `${file} is listed but there is no such file; remove it, or ${RERUN}`); continue; }
    const shows = (e && e.shows) || {};
    if (!Object.keys(shows).length) { add(file, 1, `docs/shots.json says nothing about what it shows; ${RERUN}`); continue; }
    for (const [src, h] of Object.entries(shows)) {
      const now = hashFile(root, src);
      if (now === null) add(file, 1, `shows ${src}, which no longer exists; ${RERUN}, or drop the shot`);
      else if (now !== h) add(file, 1, `older than ${src}; ${RERUN}`);
    }
  }
  for (const f of shotFiles(root)) if (!(f in m)) add(f, 1, `not in docs/shots.json; take it with npm run docs:shots so its sources are recorded`);
  return problems;
}
