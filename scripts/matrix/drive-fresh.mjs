// Drive on a freshly installed box (runner only): the user's report (#45) was a box with a project and nothing shared, where Drive said
// "No folder is shared yet. Share one from Settings on your Mac." Here: make a project through the box's own tool, then ask the box what
// Drive would list, and draw Drive's front page from those REAL answers (deck/views/files.js drawHome) in a fake DOM.
//
//   node scripts/matrix/drive-fresh.mjs <out-dir>        (after j1.sh has installed the box as container vyre-vyre-1)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { recorder } from "./lib/results.mjs";

if (!process.env.CI) { console.error("drive-fresh: runs on a CI runner only (CI is unset)"); process.exit(2); }
const out = path.resolve(process.argv[2] || "results/drive");
const r = recorder(out, "J1", "drive-fresh");
const call = (tool, input = {}) => {
  const x = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", tool, JSON.stringify(input)], { encoding: "utf8" });
  let data = null; try { data = JSON.parse(x.stdout); } catch { /* not json */ }
  return { status: x.status, data, raw: (x.stdout || "") + (x.stderr || "") };
};
// `vyre call` answers the tool's data, or { error }.
const err = c => (c.data && c.data.error) || (c.status !== 0 ? { message: c.raw.slice(0, 200) } : null);

const made = call("projects.create", { name: "Harbour Test" });
r.step("D1-project-made-on-the-server", !err(made), { why: err(made) ? err(made).message : `slug ${(made.data && (made.data.slug || (made.data.project && made.data.project.slug))) || "?"}` });
fs.mkdirSync(out, { recursive: true });

const status = call("files.drive.status"), cand = call("files.drive.candidates");
fs.writeFileSync(path.join(out, "status.json"), JSON.stringify(status.data, null, 2));
fs.writeFileSync(path.join(out, "candidates.json"), JSON.stringify(cand.data, null, 2));
const c = ((cand.data && cand.data.candidates) || []).find(x => x.kind === "project" && /harbour/i.test(String(x.name || x.slug)));
r.step("D2-box-offers-the-project", Boolean(c) && Boolean(c.via), { why: c ? `via share "${c.via && c.via.share}", folder "${c.via && c.via.rel}", path ${c.path}` : "files.drive.candidates did not list the project: " + JSON.stringify((cand.data && cand.data.candidates || []).map(x => x.name || x.path)).slice(0, 300) });
const shared = ((status.data && status.data.shares) || []).filter(s => s.shared);
r.step("D3-nothing-is-shared-yet", shared.length === 0, { why: `${shared.length} shared (a fresh box shares nothing until someone chooses)` });
if (c && c.via) {
  const l = call("files.drive.list", { share: c.via.share, path: c.via.rel });
  r.step("D4-the-project-folder-opens", !err(l), { why: err(l) ? err(l).message : `${(l.data.entries || []).length} entries` });
}

// Draw the front page from the box's real answers.
const { install, text, $$ } = await import("../../deck/test/fake-dom.js");
install();
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = n => n;
const { drawHome } = await import("../../deck/views/files.js");
const answers = { "files.drive.status": { data: status.data }, "files.drive.candidates": { data: cand.data } };
const home = await drawHome(async tool => answers[tool] || { error: { message: "missing" } });
if ("nodes" in home) {
  const el = document.createElement("div"); for (const n of home.nodes) el.append(n);
  const t = text(el);
  r.step("D5-drive-lists-the-project", /Harbour Test/.test(t) && !/No folder is shared yet|Settings on your Mac/.test(t), { why: t.replace(/\s+/g, " ").slice(0, 200) });
  r.step("D6-the-link-opens-its-folder", c && c.via ? $$(el, "a").some(a => String(a.attrs.get("href")) === `/files/${encodeURIComponent(c.via.share)}${c.via.rel ? `?p=${encodeURIComponent(c.via.rel)}` : ""}`) : false, { why: JSON.stringify($$(el, "a").map(a => a.attrs.get("href"))).slice(0, 200) });
} else r.step("D5-drive-lists-the-project", false, { why: "Drive's front page said the box is unreachable" });
process.exit(r.failed ? 1 : 0);
