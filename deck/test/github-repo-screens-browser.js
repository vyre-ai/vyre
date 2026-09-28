// @ts-check
// A real-Chrome check of the GitHub repo screens, on testbox only:
//
//   node deck/test/github-repo-screens-browser.js [--port 4798] [--out <dir>]
//
// Starts the native bar's world and one headless Chrome, then fakes every github.* tool's HTTP
// response directly (Page.addScriptToEvaluateOnNewDocument patching window.fetch), the same
// technique settings-browser.js uses for relay/onboard.status: a real page, real routing, real
// deck/js/github-repo-picker.js and deck/views/projects.js, but no real GitHub account, no real
// git clone, no real network beyond this box. Checks:
//   1. /projects "From a GitHub repo": picker opens, lists fake repos, search filters, pick one
//      calls github.project with the right input and lands on the new project.
//   2. A project's Brief tab Repos section: github.project.detect's three cases (connected, a
//      GitHub remote the connected account can't reach, no GitHub remote) render correctly, and
//      "Add a repo" calls github.project.add-repo with the picked repo and account.
//   3. A loose thread (/threads/:id): "New project from a GitHub repo…" creates the project via
//      github.project, then files the thread into it via projects.add-threads.
// A test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4798"));
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(SCRATCH, "gh-repo-shots-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(SCRATCH, "gh-repo-chrome-"));
let failed = 0;
const say = (/** @type {string} */ check, /** @type {boolean} */ pass, detail = "") => { if (!pass) failed++; process.stdout.write(JSON.stringify({ check, pass, ...(detail ? { detail } : {}) }) + "\n"); };
async function stopAll() {
  for (const p of started.reverse()) { try { p.kill("SIGTERM"); } catch {} }
  await sleep(1500);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

// The fake GitHub account and repos: the picker's own account list, plus enough repos to prove
// search and paging (page 1 has 2, "more" true; page 2 has 1 more, "more" false).
const ACCOUNTS = [{ name: "work", login: "alex-harlow" }];
const REPOS_P1 = [
  { full_name: "alex-harlow/harlow-legal-site", name: "harlow-legal-site", owner: "alex-harlow", private: false, default_branch: "main", description: "Marketing site", updated_at: "2026-09-01T00:00:00Z", html_url: "https://github.com/alex-harlow/harlow-legal-site" },
  { full_name: "alex-harlow/intake-service", name: "intake-service", owner: "alex-harlow", private: true, default_branch: "main", description: "Intake backend", updated_at: "2026-08-20T00:00:00Z", html_url: "https://github.com/alex-harlow/intake-service" },
];
const REPOS_P2 = [
  { full_name: "alex-harlow/old-archive", name: "old-archive", owner: "alex-harlow", private: false, default_branch: "main", description: "Archived", updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/alex-harlow/old-archive" },
];

try {
  const w = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "native-bar", "world.js"), "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(w);
  /** @type {{ url: string, s40: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    w.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    w.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
  });
  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9731 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const tool = async (/** @type {string} */ name, /** @type {any} */ input = {}) =>
    (await fetch(`${world.url}/v1/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) })).json();
  // A REAL project (not faked): step 1 fakes github.project's response to check the picker's own
  // wiring, but a fake response never creates a real project, so /projects/harlow-legal-site's
  // board would find nothing for step 2's Repos-section check. This one exists for real, so its
  // Brief tab loads normally; only github.project.detect on it is faked, same technique.
  const real = await tool("projects.create", { name: "harlow-legal-site" });
  if (real.error) throw new Error(`could not make the real test project: ${JSON.stringify(real.error)}`);
  const realSlug = real.data.slug;
  const tab = await openTab(CDP, { width: 1280, height: 900, scale: 1, mobile: false });
  const shot = async (/** @type {string} */ name) => {
    const r = await tab.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  };

  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__calls = [];
    const _fetch = window.fetch.bind(window);
    const ACCOUNTS = ${JSON.stringify(ACCOUNTS)};
    const REPOS_P1 = ${JSON.stringify(REPOS_P1)};
    const REPOS_P2 = ${JSON.stringify(REPOS_P2)};
    const json = (status, data) => new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    window.fetch = async (url, init) => {
      const u = typeof url === "string" ? url : String(url);
      const m = u.match(/\\/v1\\/tools\\/([a-z.\\-]+)/);
      if (!m) return _fetch(url, init);
      const tool = m[1];
      let input = {};
      try { input = init && init.body ? JSON.parse(init.body) : {}; } catch {}
      window.__calls.push({ tool, input });
      if (tool === "github.accounts") return json(200, ACCOUNTS);
      if (tool === "github.repos") {
        const q = (input.q || "").toLowerCase();
        const page = input.page || 1;
        if (q) {
          const all = [...REPOS_P1, ...REPOS_P2].filter(r => r.full_name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q));
          return json(200, { repos: all, page, limit: 30, more: false });
        }
        if (page === 1) return json(200, { repos: REPOS_P1, page: 1, limit: 2, more: true });
        return json(200, { repos: REPOS_P2, page: 2, limit: 2, more: false });
      }
      if (tool === "github.project") return json(200, { project: "harlow-legal-site", home: "/fake/harlow-legal-site", full_name: input.repo, default_branch: "main" });
      if (tool === "github.project.add-repo") return json(200, { project: input.project, folder: "/fake/" + (input.repo || "").split("/").pop(), full_name: input.repo, default_branch: "main" });
      if (tool === "github.project.detect") {
        return json(200, { project: input.project, workspaces: [
          { folder: "/fake/harlow-legal-site", isRepo: true, remotes: [{ name: "origin", url: "https://github.com/alex-harlow/harlow-legal-site.git", full_name: "alex-harlow/harlow-legal-site", match: { account: "work", full_name: "alex-harlow/harlow-legal-site", default_branch: "main" } }] },
          { folder: "/fake/no-account-repo", isRepo: true, remotes: [{ name: "origin", url: "https://github.com/someone-else/private-repo.git", full_name: "someone-else/private-repo", match: null }] },
          { folder: "/fake/plain-git", isRepo: true, remotes: [] },
        ] });
      }
      if (tool === "projects.create") return json(200, { slug: "harlow-legal-site", name: "harlow-legal-site" });
      if (tool === "projects.add-threads") return json(200, { added: 1 });
      return _fetch(url, init);
    };
  ` });
  await tab.go(`${world.url}/projects`, 2500);
  await tab.run(`await waitFor("button", 8000); return true;`);

  // 1. New project from a GitHub repo: the picker, search, paging, pick, navigate.
  await tab.run(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("From a GitHub repo")).click();
    await waitFor(".gh-pick-row", 4000); return true;`);
  const p1 = await tab.run(`return [...document.querySelectorAll(".gh-pick-name")].map(e => e.textContent);`);
  say("the picker lists page 1's repos", p1.some(t => t.includes("harlow-legal-site")) && p1.some(t => t.includes("intake-service")), JSON.stringify(p1));
  say("a private repo shows its badge", (await tab.run(`return !!document.querySelector(".gh-pick-private");`)));
  await shot("gh-picker-list");

  await tab.run(`[...document.querySelectorAll(".gh-pick-more button")][0]?.click(); await wait(400); return true;`);
  const p2 = await tab.run(`return [...document.querySelectorAll(".gh-pick-name")].map(e => e.textContent);`);
  say("\"Show more\" appends page 2 without dropping page 1", p2.some(t => t.includes("old-archive")) && p2.some(t => t.includes("harlow-legal-site")), JSON.stringify(p2));

  await tab.run(`type(".gh-pick input[type=search]", "intake"); return true;`);
  await sleep(500);
  const searched = await tab.run(`return [...document.querySelectorAll(".gh-pick-name")].map(e => e.textContent);`);
  say("search filters to the matching repo only", searched.length === 1 && searched[0].includes("intake-service"), JSON.stringify(searched));

  await tab.run(`type(".gh-pick input[type=search]", ""); document.querySelector(".gh-pick input[type=search]").dispatchEvent(new Event("input")); await wait(500); return true;`);
  await tab.run(`await waitFor(".gh-pick-row", 4000);
    [...document.querySelectorAll(".gh-pick-row")].find(b => b.textContent.includes("harlow-legal-site")).click(); await wait(600); return true;`);
  const afterPick = await tab.run(`return { path: location.pathname, calls: window.__calls.filter(c => c.tool === "github.project") };`);
  say("picking a repo calls github.project with its full_name, and navigates to the new project", afterPick.path.includes("harlow-legal-site") && afterPick.calls[0]?.input.repo === "alex-harlow/harlow-legal-site", JSON.stringify(afterPick));

  // 2. The project's Brief tab, Repos section: detect's three cases.
  await tab.go(`${world.url}/projects/${realSlug}?tab=brief`, 2000);
  await tab.run(`await waitFor(".pj-repo-row", 8000); return true;`);
  const repoRows = await tab.run(`return [...document.querySelectorAll(".pj-repo-row")].map(r => r.textContent);`);
  say("a folder with a matching connected account says Connected to owner/repo",
    repoRows.some(t => /Connected to alex-harlow\/harlow-legal-site/.test(t)), JSON.stringify(repoRows));
  say("a GitHub remote the connected account can't reach says so, not \"connected\"",
    repoRows.some(t => /someone-else\/private-repo/.test(t) && /can't reach/.test(t)), JSON.stringify(repoRows));
  say("a folder with no GitHub remote says \"Git repo, not GitHub\", never a link prompt",
    repoRows.some(t => /Git repo, not GitHub/.test(t)), JSON.stringify(repoRows));
  say("no \"link this?\" wording anywhere (there is no link concept)", !repoRows.some(t => /link/i.test(t)), JSON.stringify(repoRows));
  await shot("pj-repos-section");

  await tab.run(`(await waitFor(".pj-repos-add button", 4000)).click();
    await waitFor(".gh-pick", 4000); return true;`);
  await tab.run(`await waitFor(".gh-pick-row", 4000);
    [...document.querySelectorAll(".gh-pick-row")].find(b => b.textContent.includes("intake-service")).click(); await wait(500); return true;`);
  const addCall = await tab.run(`return window.__calls.filter(c => c.tool === "github.project.add-repo")[0] || null;`);
  say("\"Add a repo\" calls github.project.add-repo with the project, repo and account, never touching an existing folder",
    addCall && addCall.input.project === realSlug && addCall.input.repo === "alex-harlow/intake-service" && addCall.input.account === "work", JSON.stringify(addCall));

  // 3. A loose thread: "New project from a GitHub repo…" creates the project and files the
  // thread into it in one flow.
  await tab.go(`${world.url}/threads/${world.s40}`, 2000);
  await tab.run(`await waitFor(".lt-add button, .lt-add", 8000); return true;`);
  const addBtn = await tab.run(`const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("Add to a project")); if (b) b.click(); return !!b;`);
  say("the loose thread offers \"Add to a project\"", addBtn);
  await tab.run(`await waitFor(".lt-form", 4000); return true;`);
  await tab.run(`[...document.querySelectorAll(".lt-form button")].find(b => b.textContent.includes("New project from a GitHub repo")).click();
    await waitFor(".gh-pick", 4000); return true;`);
  await tab.run(`await waitFor(".gh-pick-row", 4000);
    [...document.querySelectorAll(".gh-pick-row")].find(b => b.textContent.includes("harlow-legal-site")).click(); await wait(700); return true;`);
  const afterFile = await tab.run(`return {
    path: location.pathname,
    projectCall: window.__calls.filter(c => c.tool === "github.project").pop(),
    filedCall: window.__calls.filter(c => c.tool === "projects.add-threads").pop(),
  };`);
  say("the new-project-from-repo option creates the project, then files the thread into it",
    afterFile.projectCall && afterFile.filedCall && afterFile.filedCall.input.project === "harlow-legal-site" && afterFile.filedCall.input.threads?.[0] === world.s40 && afterFile.path.includes(world.s40),
    JSON.stringify(afterFile));

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
