// @ts-check
// Drive's front page (deck/views/files.js drawHome) rendered into a fake DOM with a fake API: a fresh box with a project and
// nothing shared lists the project (it used to say "No folder is shared yet" and "Share one from Settings on your Mac"), the
// project opens into its own folder, shared folders sit under their own heading, and a box with neither says what to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $$ } from "./fake-dom.js";

install();
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
const { drawHome } = await import("../views/files.js");

const api = (/** @type {Record<string, any>} */ answers) => async (/** @type {string} */ tool) => (tool in answers ? answers[tool] : { error: { code: "no_such_tool", message: `no tool ${tool}`, missing: true } });
const page = (/** @type {any} */ r) => { const el = document.createElement("div"); for (const n of r.nodes) el.append(n); return el; };

test("drive home: a fresh box with a project and nothing shared lists the project, opening into its own folder", async () => {
  const r = await drawHome(api({
    "files.drive.status": { data: { enabled: false, shares: [{ name: "projects", path: "/work", access: "ro", shared: false }] } },
    "files.drive.candidates": { data: { candidates: [{ kind: "project", slug: "harlow-legal", name: "Harlow Legal", path: "/work/harlow-legal", via: { share: "projects", rel: "harlow-legal" } }, { kind: "folder", name: "scratch", path: "/work/scratch", via: { share: "projects", rel: "scratch" } }] } },
  }));
  assert.ok("nodes" in r);
  const el = page(r);
  const t = text(el);
  assert.match(t, /Projects on your server/);
  assert.match(t, /Harlow Legal/);
  assert.doesNotMatch(t, /No folder is shared yet|Settings on your Mac|Shared with your Macs/);
  const hrefs = $$(el, "a").map(a => a.attrs.get("href"));
  assert.deepEqual(hrefs, ["/files/projects?p=harlow-legal"]);
});

test("drive home: shared folders sit under their own heading, after the projects", async () => {
  const r = await drawHome(api({
    "files.drive.status": { data: { shares: [{ name: "site", path: "/work/site", shared: true }, { name: "notes", path: "/work/notes", shared: false }] } },
    "files.drive.candidates": { data: { candidates: [{ kind: "project", slug: "a", name: "A", via: { share: "site", rel: "" } }] } },
  }));
  assert.ok("nodes" in r);
  const t = text(page(r));
  assert.ok(t.indexOf("Projects on your server") < t.indexOf("Shared with your Macs"));
  assert.deepEqual($$(page(r), "a").map(a => a.attrs.get("href")), ["/files/site", "/files/site"]);
});

test("drive home: a box with no project and nothing shared says what to do, and an older box without the picker still lists what is shared", async () => {
  const none = await drawHome(api({ "files.drive.status": { data: { shares: [] } }, "files.drive.candidates": { data: { candidates: [] } } }));
  assert.ok("nodes" in none);
  const t = text(page(none));
  assert.match(t, /No project is on your server yet/);
  assert.match(t, /Make a project/);
  assert.deepEqual($$(page(none), "a").map(a => a.attrs.get("href")), ["/projects"]);
  const old = await drawHome(api({ "files.drive.status": { data: { shares: [{ name: "projects", shared: true }] } } }));
  assert.ok("nodes" in old);
  assert.match(text(page(old)), /Shared with your Macs/);
  const down = await drawHome(api({}));
  assert.ok("error" in down);
});
