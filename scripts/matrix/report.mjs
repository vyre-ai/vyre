// Folds every device's results.jsonl under a folder into results.json and index.html, the
// results page: a grid of journeys by devices, red first, each cell's steps with screenshots.
//   node scripts/matrix/report.mjs <folder> [--sha <sha>] [--run <url>]
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || "results";
const arg = (name, def = "") => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const lines = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "results.jsonl") {
      const base = path.relative(root, dir);
      for (const l of fs.readFileSync(p, "utf8").split("\n").filter(Boolean)) {
        const o = JSON.parse(l);
        if (o.shot) o.shot = path.join(base, o.shot);
        lines.push(o);
      }
    }
  }
};
walk(root);

const cells = new Map();
for (const l of lines) {
  const k = `${l.journey}\u0000${l.device}`;
  if (!cells.has(k)) cells.set(k, { journey: l.journey, device: l.device, steps: [] });
  cells.get(k).steps.push(l);
}
const state = c => c.steps.some(s => s.ok === false) ? "red" : c.steps.every(s => s.ok === true) ? "green" : "other";
const journeys = [...new Set(lines.map(l => l.journey))].sort();
const devices = [...new Set(lines.map(l => l.device))].sort();
const results = { sha: arg("sha"), run: arg("run"), made: new Date().toISOString(), cells: [...cells.values()].map(c => ({ ...c, state: state(c) })) };
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const count = st => results.cells.filter(c => c.state === st).length;
const grid = journeys.map(j => `<tr><th>${esc(j)}</th>${devices.map(d => {
  const c = cells.get(`${j}\u0000${d}`);
  return c ? `<td class="${state(c)}"><a href="#${esc(j)}-${esc(d)}">${state(c) === "green" ? "pass" : state(c) === "red" ? "FAIL" : "partial"}</a></td>` : "<td></td>";
}).join("")}</tr>`).join("");
const detail = [...results.cells].sort((a, b) => (a.state === "red" ? 0 : 1) - (b.state === "red" ? 0 : 1)).map(c => `
<section id="${esc(c.journey)}-${esc(c.device)}"><h2 class="${c.state}">${esc(c.journey)} on ${esc(c.device)}</h2><ol>${c.steps.map(s => `
<li class="${s.ok === true ? "green" : s.ok === false ? "red" : "other"}"><b>${esc(s.step)}</b> ${s.ok === true ? "pass" : s.ok === false ? "FAIL" : esc(s.ok)}${s.ms ? ` (${s.ms} ms)` : ""}${s.why ? `<div class="why">${esc(s.why)}</div>` : ""}${s.shot ? `<a href="${esc(s.shot)}"><img src="${esc(s.shot)}" alt="${esc(s.step)} on ${esc(c.device)}"></a>` : ""}</li>`).join("")}</ol></section>`).join("");

fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Matrix results</title>
<style>
:root{--bg:#fff;--text:#1a1a1a;--muted:#666;--green:#1f7a3a;--red:#b3261e;--other:#8a6d00;--rule:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--text:#eee;--muted:#aaa;--green:#6fd08c;--red:#ff8a80;--other:#e6c35c;--rule:#333}}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--rule);padding:6px 10px;text-align:left}
.green,.green a{color:var(--green)}.red,.red a{color:var(--red);font-weight:600}.other,.other a{color:var(--other)}
.why{color:var(--muted);font-size:13px}img{display:block;max-width:100%;max-height:420px;margin:6px 0;border:1px solid var(--rule)}
</style>
<h1>Matrix results</h1>
<p>${esc(results.sha)} ${results.run ? `<a href="${esc(results.run)}">run</a>` : ""} · ${esc(results.made)} · ${count("green")} green, ${count("red")} red, ${count("other")} partial</p>
<table><tr><th></th>${devices.map(d => `<th>${esc(d)}</th>`).join("")}</tr>${grid}</table>${detail}`);
console.log(`report: ${results.cells.length} cells, ${count("green")} green, ${count("red")} red -> ${path.join(root, "index.html")}`);
process.exit(count("red") ? 1 : 0);
