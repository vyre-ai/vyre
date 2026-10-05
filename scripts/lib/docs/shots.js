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
//   world    which sample world renders it: deck (the Deck, from web/test/world.js), onboard
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

const ONBOARD = ["web/onboard/onboard.js", "web/onboard/onboard.css", "web/onboard/index.html", "web/css/deck.css", "core/onboard/index.js"];
const BOTH = ["light", "dark"];


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
  { name: "onboarding-devices", dir: "get-started", world: "onboard", url: "#devices", width: 1280, height: "fit", maxHeight: 1300, themes: ["dark"], shows: [...ONBOARD, "web/js/phone-code.js", "web/css/phone-code.css"],
    script: `await until('document.querySelector(".pair-list") && document.querySelector(".pair-list").children.length', 15000); await wait(800);`,
    fit: ".ob-main",
    alt: "Step 6: the Pair this Mac card with alex-mbp asking to pair and a field for its code, and the Open Vyre on your phone card with a code for Tailscale and one for this box's address.",
    page: "get-started/onboarding.md", heading: "6. Your devices" },
  { name: "onboarding-ready", dir: "get-started", world: "onboard", url: "#ready", width: 1280, height: 800, themes: ["dark"], shows: ONBOARD,
    alt: "The last screen of the setup: Vyre is ready, with your Mac, your phone and your history ticked or still to do, and Open Vyre.",
    page: "get-started/onboarding.md", heading: "The last screen" },

  // ---- The Deck ----
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
