#!/usr/bin/env node
// app-walk-plain: opens most screens of the app on a seeded box and says which show a blank page, a page error, or words a person should never read (ids like fl_ or per_, role:x, vyre://, undefined, [object Object], NaN). TEST BOX ONLY.
// It starts a vyred of its own in a temp home (kernel on), seeds a project from a template, a Flow with lanes, agents, a contact and a to-do, serves a web export of the app in front of it and drives a browser.
//   node scripts/app-walk-plain.mjs --dist apps/app/dist [--out dir] [--only word,word]
// It prints one line per screen and width (OK or what is wrong) and keeps a picture of each in --out. Exit code 1 when any screen is wrong.
import "./mac-test-guard.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { start } from "../core/daemon/index.js";
import { paths } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const DIST = path.resolve(flag("--dist", "apps/app/dist-shots"));
const OUT = path.resolve(flag("--out", "plain-walk"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

// ---- a daemon of its own, seeded
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-plain-walk-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const space = d.kernel.id.space, owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const TOKEN = (await d.kernel.surfaces.open(ownerChain, {})).token;
const call = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: TOKEN }); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
const host = d.registry.deps.flowsHost.get(space);
const install = async (flow) => { const r = await d.registry.call("flows.define", { flow }, "cli", { token: TOKEN }); if (!r.data || !r.data.ok) throw new Error(JSON.stringify(r)); await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash }); return r.data; };
await d.kernel.gateway.records.define(ownerChain, { add_types: [{ name: "filing-note", label: "Filing note", fields: [{ name: "body", kind: "text", label: "Body" }] }] });
await install({ format: 1, name: "inner_note", label: "Write the inner note", authorship: "human", trigger: { on: "manual" }, returns: { body: { expr: "steps.c.record.data.body" } }, steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: "inner" } }] });
const outer = await install({ format: 1, name: "file_it", label: "File it", authorship: "human", trigger: { on: "manual" }, steps: [
  { id: "p", kind: "parallel", steps: [
    { id: "review", kind: "branch", steps: [{ id: "look", kind: "assign", to: `person:${owner}`, title: "Look it over", output: { kind: "decision" }, how: "person", await: true }] },
    { id: "draft", kind: "branch", steps: [{ id: "s", kind: "subflow", flow: "inner_note" }] },
  ] },
  { id: "after", kind: "create", type: "filing-note", set: { body: { expr: "\"after: \" + steps.s.result.body" } } },
] });
await host.flows.tools["flows.start"](host.personChain(), { id: outer.id, input: {} });
// a Flow whose second lane cannot finish (nobody holds the role): the run did not finish, and the page says so and offers one Retry
const failing = await install({ format: 1, name: "two_checks", label: "Two checks", authorship: "human", trigger: { on: "manual" }, steps: [
  { id: "p", kind: "parallel", steps: [
    { id: "fine", kind: "branch", steps: [{ id: "n", kind: "create", type: "filing-note", set: { body: "fine" } }] },
    { id: "stuck", kind: "branch", steps: [{ id: "q", kind: "ask", to: "role:nobody_holds_this", title: "Anyone?" }] },
  ] },
] });
await host.flows.tools["flows.start"](host.personChain(), { id: failing.id, input: {} });
// a draft nobody has approved yet: the page offers the approval
const draftOf = async (name, label) => (await d.registry.call("flows.define", { flow: { format: 1, name, label, authorship: "human", trigger: { on: "manual" }, steps: [{ id: "n", kind: "create", type: "filing-note", set: { body: "told" } }] } }, "cli", { token: TOKEN })).data;
const draft = await draftOf("tell_the_client", "Tell the client"), draft2 = await draftOf("tell_the_court", "Tell the court");   // one for each width: the first pass approves its own
await call("agents.create", { name: "research", kind: "agent", projects: [], instructions: "Finds and reads the documents." });
const lib = await call("work.template.install", { id: "law-firm/estate-plan" });
await call("work.template.golive", { template: lib.template, version: lib.version });
const started = await call("work.start-project", { template: lib.template, name: "Rivera Family Trust", repo: "" });
const plain = await call("work.project.create", { name: "Plain chats" });
const idOf = (urn) => String(urn).split("/").pop();
const PROJECT = idOf(started.project), PLAIN = idOf(plain.project);
const contact = await d.kernel.gateway.records.create(ownerChain, "contact", { name: "Jane Rivera" }).catch(() => null);
const task = await d.kernel.gateway.ask.request(ownerChain, { title: "Approve the draft trust", doer: { kind: "person", id: owner, space }, output: { kind: "decision" } }).catch(() => null);
const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {}).catch(() => null);
await new Promise((r) => setTimeout(r, 4000));
const ROUTES = [
  ["now", "/u/now"], ["now-needs", "/u/now/needs"], ["flows", "/u/flows"], ["flow", `/u/flows/${outer.id}`], ["flow-failed", `/u/flows/${failing.id}`], ["flow-draft", `/u/flows/${draft.id}`], ["flow-draft-2", `/u/flows/${draft2.id}`], ["kits", "/u/kits"], ["engineer", "/u/engineer"],
  ["projects", "/u/projects"], ["project", `/u/project/${PROJECT}`], ["project-free", `/u/project/${PLAIN}`], ["templates", "/u/templates"], ["template", `/u/templates/${lib.template}`],
  ["assistants", "/u/assistants"], ["settings-assistants", "/u/settings/assistants"], ["planner", "/u/planner"], ["calendar", "/u/calendar"], ["drive", "/u/drive"],
  ["chats", "/u/chats"], ["connections", "/u/connections"], ["spaces", "/u/spaces"], ["search", "/u/search"], ["records-contact", "/u/records/contact"],
  ["now-doing", "/u/now/doing"], ["settings", "/u/settings"], ["settings-account", "/u/settings/account"], ["settings-all", "/u/settings/all"], ["settings-devices", "/u/settings/devices"], ["settings-engineer", "/u/settings/engineer"], ["settings-notifications", "/u/settings/notifications"], ["settings-permissions", "/u/settings/permissions"], ["settings-privacy", "/u/settings/privacy"], ["settings-seeing", "/u/settings/seeing"], ["settings-spend", "/u/settings/spend"], ["settings-system", "/u/settings/system"], ["records-organization", "/u/records/organization"], ["tag", "/u/tags/estate"], ["wink", "/u/wink"], ["settings-ai", "/u/settings/ai"], ["settings-backups", "/u/settings/backups"], ["settings-rules", "/u/settings/rules"], ["settings-updates", "/u/settings/updates"], ["settings-outside", "/u/settings/outside"],
  ["vault", "/u/vault"], ["sites", "/u/sites"], ["sidebar", "/u/sidebar"], ["about", "/u/about"], ["access", "/u/access"], ["appearance", "/u/appearance"],
  ...(contact ? [["record", `/u/record/${contact.id}`]] : []), ...(task ? [["task", `/u/task/${task.id}`]] : []), ...(chat ? [["chat", `/u/chats/${chat.id}`]] : []),
];
// not walked: /u/memory (the main memory graph is drawn only for the real Deck surface; a walk answers as one caller and gets "denied"), /u/install/* and pairing (they need a fresh phone)
const ONLY = flag("--only", "").split(",").filter(Boolean);
// ---- the app in front of it
const SOCKET = paths(root).socket;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
    // the app's tool calls go straight to this process's registry as the owner's session (a socket client of a shell on this box is classed by where it runs, which a screenshot walk must not depend on)
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && u.pathname.startsWith("/v1/tools/")) {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        let input = {}; try { input = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
        const tool = decodeURIComponent(u.pathname.slice("/v1/tools/".length));
        const r = await d.registry.call(tool, input, "deck", { token: TOKEN });          // the app calls as the Deck, like a person at the screen
        if (r.error) console.log("tool error:", tool, r.error.code, String(r.error.message).slice(0, 160));
        send(200, r.error ? { error: r.error } : { data: r.data });
      });
      return;
    }
    console.log("unserved:", req.method, u.pathname);
    return send(u.pathname === "/v1/health" ? 200 : 404, u.pathname === "/v1/health" ? { ok: true } : { error: { code: "not_found", message: "not served by the walk" } });
  }
  const p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/app/, "") || "/";
  let f = path.join(DIST, p);
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
  if (missing) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}/app`;
const BAD = [[/\bfl_[0-9a-f]{8}/, "a Flow id"], [/\bper_[a-z0-9]{12,}/, "a person id"], [/\bspc_[a-z2-7]{8,}/, "a space id"], [/\brun_[a-z0-9]{6,}/, "a run id"], [/vyre:\/\//, "a vyre:// address"],
  [/\b(role|teammate|person|pool):[a-z]/, "a role or person reference"], [/\bundefined\b/, "undefined"], [/\[object Object\]/, "[object Object]"], [/\bNaN\b/, "NaN"], [/\bnull\b/, "null"], [/\b[a-z]+(-[a-z]+)+\.(created|updated|removed)\b/, "an event name (def-flow.created)"], [/did not load\b/, "an error state"], [/That did not (go through|work)/, "an error toast"]];
const browser = await chromium.launch({ args: [...CHROME_SAFE] });
let wrong = 0;
// each screen on a wide screen in light and on a phone in dark, so a layout that hides words shows up too
for (const [wide, viewport, scheme] of [["wide", { width: 1440, height: 900 }, "light"], ["phone", { width: 390, height: 844 }, "dark"]]) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block" });
  for (const [name, route] of ROUTES) {
    if (ONLY.length && !ONLY.some((w) => name.includes(w))) continue;
    const pg = await ctx.newPage();
    const problems = [];
    try {
    pg.on("pageerror", (e) => problems.push(`page error: ${String(e).slice(0, 120)}`));
    await pg.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" }).catch((e) => problems.push(`did not open: ${String(e).slice(0, 80)}`));
    await pg.waitForTimeout(3500);
    // one real action where a screen has its main one: run a Flow, open a project's timeline
    if (name === "flow") { await pg.getByText("Run now", { exact: true }).first().click().catch(() => {}); await pg.waitForTimeout(2500); }
    if (name === "flow-failed") {
      // the run did not finish: its row says so in words, a click shows what happened, and there is one Retry (not one for each lane)
      const row = pg.getByText(/^Run of /).first();
      if (await row.count()) { await row.click().catch(() => {}); await pg.waitForTimeout(2500); }
      else problems.push("the failed Flow lists no run");
      const t = (await pg.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!/did not finish|nobody holds the role|no one to ask/i.test(t)) problems.push(`the failed run does not say it did not finish: ${t.slice(0, 160)}`);
      if (/\bfine Not reached\b/.test(t)) problems.push("a lane whose steps ran reads \"Not reached\"");
      const retries = await pg.getByText("Retry this run", { exact: true }).count();
      if (retries !== 1) problems.push(`the failed run offers ${retries} Retry buttons, not one`);
    }
    if ((name === "flow-draft" && wide === "wide") || (name === "flow-draft-2" && wide === "phone")) {
      // the person approves the draft: the button must say what it does, and afterwards the Flow can run
      const before = (await pg.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      if (/Face ID|fingerprint|Touch ID|passkey/i.test(before)) problems.push("the approve button names a biometric the box does not ask for");
      await pg.screenshot({ path: path.join(OUT, `${name}-${wide}-before.png`), fullPage: true });
      await pg.getByText(/^Approve$/).first().click().catch(() => problems.push("no Approve button on a draft Flow"));
      await pg.waitForTimeout(3500);
      if (!(await pg.getByText("Run now", { exact: true }).count())) problems.push("approving the draft did not make it runnable");
    }
    if (name === "now" && wide === "wide") {
      // a to-do is done from its card: the card goes away (the phone's cards sit under a swipe layer that a browser's pointer cannot press through; the apps are native, so only the wide pass presses)
      const done = pg.getByText("Mark done", { exact: true });
      const before = await done.count();
      if (before) {
        await done.first().click({ timeout: 8000 }).catch((e) => problems.push(`Mark done could not be pressed: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 200)}`));
        await pg.waitForTimeout(3000);
        if ((await pg.getByText("Mark done", { exact: true }).count()) >= before) problems.push("Mark done left the to-do on Now");
      }
    }
    if (name === "projects" && wide === "wide") {
      // a person makes a plain project: New, then Project
      await pg.getByLabel("New", { exact: true }).first().click({ timeout: 8000 }).catch(() => problems.push("no New button on Projects"));
      await pg.waitForTimeout(1500);
      const item = pg.getByText("New project", { exact: true }).first();
      if (await item.count()) {
        await item.click({ timeout: 8000 }).catch((e) => problems.push(`New project could not be chosen: ${String(e.message || e).split("\n")[0].slice(0, 100)}`));
        await pg.waitForTimeout(3500);
        if (!pg.url().includes("/u/project/")) problems.push(`New project did not open a project (${pg.url().slice(-50)})`);
        else { await pg.waitForTimeout(4000); await pg.screenshot({ path: path.join(OUT, "project-new-wide.png"), fullPage: true }); const t = (await pg.locator("body").innerText()).replace(/\s+/g, " "); console.log("new project page:", t.slice(0, 300)); if (/no short name/i.test(t)) problems.push("a new project has no short name chats can be filed under"); }
      } else problems.push(`the New menu has no New project: ${(await pg.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (name === "flows") {
      // the switch on a Flow pauses it and turns it on again
      const sw = pg.getByRole("switch").first();
      if (await sw.count()) {
        const was = await sw.getAttribute("aria-checked");
        await sw.click().catch(() => {}); await pg.waitForTimeout(2000);
        const now = await pg.getByRole("switch").first().getAttribute("aria-checked");
        if (was === now) problems.push("the Flow switch did not change");
        await pg.getByRole("switch").first().click().catch(() => {}); await pg.waitForTimeout(1500);
      } else problems.push("the Flows list has no switch");
    }
    if (name === "project-free") {
      // a chat started from a project belongs to it
      await pg.getByText("New chat", { exact: true }).first().click().catch(() => problems.push("no New chat on a project"));
      await pg.waitForTimeout(3000);
      if (!/\/u\/chats\//.test(pg.url())) problems.push(`New chat did not open a chat (${pg.url().slice(-60)})`);
    }
    if (name === "template") {
      // a person starts a project from the template: name it, press Start, land on its page
      await pg.screenshot({ path: path.join(OUT, `template-${wide}-start.png`), fullPage: true });
      const field = pg.getByPlaceholder("Rivera Family Trust");
      if (await field.count()) { await field.fill(`Okafor Estate ${wide}`); await pg.getByText("Start project", { exact: true }).first().click().catch(() => {}); await pg.waitForTimeout(5000); if (!pg.url().includes("/u/project/")) problems.push("starting a project did not open it"); }
      else problems.push("the template page has no Start project");
    }
    if (name === "project") {
      // the Overview, then the Team and the Timeline tabs: each a screen a person opens first thing
      await pg.screenshot({ path: path.join(OUT, `project-overview-${wide}.png`), fullPage: false });
      await pg.getByText("Team", { exact: true }).first().click().catch(() => {}); await pg.waitForTimeout(2500);
      await pg.screenshot({ path: path.join(OUT, `project-team-${wide}.png`), fullPage: false });
      await pg.getByText("Timeline", { exact: true }).first().click().catch(() => {}); await pg.waitForTimeout(2500);
    }
    const text = (await pg.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (text.replace(/My Cloud|Now|Chat|Projects|Contacts|Drive|More|Search|Settings|You/g, "").trim().length < 12) problems.push("blank page");
    for (const [re, what] of BAD) { const m = re.exec(text); if (m) problems.push(`shows ${what}: "${text.slice(Math.max(0, m.index - 30), m.index + 40)}"`); }
    await pg.screenshot({ path: path.join(OUT, `${name}-${wide}.png`), fullPage: false });
    } catch (e) { problems.push(`the browser tab failed: ${String(e.message || e).split("\n")[0].slice(0, 100)} (a loaded box can crash a tab; run it again)`); }
    console.log(problems.length ? `WRONG ${name} ${wide} (${route}): ${problems.join(" | ")}` : `OK    ${name} ${wide}`);
    if (problems.length) wrong++;
    await pg.close();
  }
  await ctx.close();
}
await browser.close(); server.close(); await d.stop(); process.exit(wrong ? 1 : 0);
