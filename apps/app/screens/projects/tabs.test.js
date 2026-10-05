// @ts-check
// The project page's Brief, Files and Memory tabs: what each tool is asked, how each answer becomes lines, and that nothing from another machine or inside a file shows.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o.error?.[tool]) return { error: o.error[tool] };
    switch (tool) {
      case "projects.list": return { data: { projects: [{ slug: "harlow", name: "Harlow Legal", home: "/p/harlow", workspaces: ["/p/harlow", "/p/harlow-site"] }, { slug: "harlow", name: "Mac copy", source: "mac" }, { slug: "other", name: "Other" }] } };
      case "projects.context": return { data: { text: "You are working in the Vyre project Harlow.\nThis brief is background from Vyre.\nHome: /p/harlow\n- People: Dana, Kit\nOther threads in this project\n- Intake call" } };
      case "projects.threads": return { data: [{ id: "t3", label: "Old intake", last: 5 }, { id: "t1", name: "Live one", last: 1 }, { nope: 1 }] };
      case "threads.list": return { data: [{ id: "t1", name: "Live one", project: "harlow", state: "running", last: 9 }, { id: "t2", name: "Waiting", project: "harlow", state: "waiting", last: 20 }, { id: "t9", name: "Elsewhere", project: "other", state: "running" }, { id: "t8", project: "harlow", state: "stopped" }] };
      case "harness.touched": return { data: input.session === "t2" ? [{ path: "/p/harlow/a/b/c/plan.md", tool: "Write", at: 300 }] : [{ path: "/p/harlow/x.txt", tool: "Edit", at: 100 }, { tool: "no path" }] };
      case "memory.facts": return { data: { facts: [{ id: "f1", text: "Dana prefers email", ref: { name: "Intake call" } }, { text: "" }, { id: "f3", text: "Kit owns intake", source: "flows" }] } };
      case "github.project.detect": return { data: { workspaces: [{ folder: "/p/harlow", isRepo: true, remotes: [{ full_name: "acme/harlow", match: true }] }, { folder: "/p/harlow-site", isRepo: true, remotes: [{ full_name: "acme/site" }] }, { folder: "/p/x", isRepo: true, remotes: [] }, { folder: "/p/y" }] } };
      default: return { data: {} };
    }
  };
  return { call, seen };
}

test("the brief: the model's preamble is dropped, Home is mono, a section opens with a heading, and the folders come from projects.list (never a Mac's copy)", { skip: !strip }, async () => {
  const { projectTabsSource } = await import("./tabs-source.ts");
  const { briefLines } = await import("./tabs-model.ts");
  const b = box();
  const r = await projectTabsSource(b.call).brief("harlow");
  assert.deepEqual(b.seen.map((s) => [s.tool, s.input]), [["projects.list", {}], ["projects.context", { project: "harlow" }]]);
  assert.deepEqual(r.project, { slug: "harlow", name: "Harlow Legal", home: "/p/harlow", workspaces: ["/p/harlow", "/p/harlow-site"] });
  assert.deepEqual(briefLines(r.text), [{ text: "Home: /p/harlow", mono: true, heading: false }, { text: "People: Dana, Kit", mono: false, heading: true }, { text: "Other threads in this project", mono: false, heading: true }, { text: "Intake call", mono: false, heading: false }]);
  assert.deepEqual(briefLines(""), []);
  assert.equal((await projectTabsSource(box().call).info("nope")), null);
});

test("the project's chats: live ones first by recency, then recorded ones, none from another project and no duplicate", { skip: !strip }, async () => {
  const { projectTabsSource } = await import("./tabs-source.ts");
  const b = box();
  const items = await projectTabsSource(b.call).items("harlow");
  assert.deepEqual(items.map((i) => i.id), ["t2", "t1", "t3"]);
  assert.deepEqual(b.seen.map((s) => [s.tool, s.input]).sort(), [["projects.threads", { project: "harlow" }], ["threads.list", { machines: "local" }]]);
  const none = await projectTabsSource(box({ error: { "projects.threads": { code: "no_such_tool", message: "x" }, "threads.list": { code: "no_such_tool", message: "x" } } }).call).items("harlow");
  assert.deepEqual(none, [], "a box without the Switchboard has no chats here, and the tab still draws");
});

test("files: each of the project's threads is asked for what it touched, newest first, naming its thread; a path-less row is dropped; contents are never asked for", { skip: !strip }, async () => {
  const { projectTabsSource } = await import("./tabs-source.ts");
  const { splitPath } = await import("./tabs-model.ts");
  const b = box();
  const r = await projectTabsSource(b.call).touched("harlow");
  assert.deepEqual(r.rows.map((x) => [x.path, x.tool, x.threadName]), [["/p/harlow/a/b/c/plan.md", "Write", "Waiting"], ["/p/harlow/x.txt", "Edit", "Live one"], ["/p/harlow/x.txt", "Edit", "Old intake"]]);
  assert.deepEqual(b.seen.filter((s) => s.tool === "harness.touched").map((s) => s.input).sort((a, c) => a.session.localeCompare(c.session)), [{ session: "t1", limit: 50 }, { session: "t2", limit: 50 }, { session: "t3", limit: 50 }]);
  assert.equal(b.seen.some((s) => /read|preview|download/.test(s.tool)), false);
  assert.deepEqual(splitPath("/p/harlow/a/b/c/plan.md"), { dir: "…/b/c/", base: "plan.md" });
  assert.deepEqual(splitPath("plan.md"), { dir: "", base: "plan.md" });
  assert.deepEqual(splitPath("/a/b.txt"), { dir: "/a/", base: "b.txt" });
  const failing = await projectTabsSource(box({ error: { "harness.touched": { code: "no_such_tool", message: "no harness" } } }).call).touched("harlow");
  assert.deepEqual([failing.rows, failing.error], [[], "no harness"]);
});

test("memory: the facts are asked about the project's home and every other folder once each; a fact with no text is dropped", { skip: !strip }, async () => {
  const { projectTabsSource } = await import("./tabs-source.ts");
  const b = box();
  const facts = await projectTabsSource(b.call).facts("harlow");
  assert.deepEqual(facts, [{ id: "f1", text: "Dana prefers email", from: "Intake call" }, { id: "f3", text: "Kit owns intake", from: "flows" }]);
  assert.deepEqual(b.seen.find((s) => s.tool === "memory.facts")?.input, { project_cwds: ["/p/harlow", "/p/harlow-site"], limit: 100 });
  assert.deepEqual(await projectTabsSource(box().call).facts("nope"), [], "an unknown project asks nothing");
});

test("repos: connected, reachable-but-not, plain git and not a repo; a link is only ever github.com/<owner>/<name>; add-repo only adds", { skip: !strip }, async () => {
  const { projectTabsSource } = await import("./tabs-source.ts");
  const { reposOf } = await import("./tabs-model.ts");
  const b = box();
  const s = projectTabsSource(b.call);
  assert.deepEqual(await s.repos("harlow"), [
    { folder: "harlow", status: "Connected to acme/harlow", link: "https://github.com/acme/harlow" },
    { folder: "harlow-site", status: "acme/site, but the connected account can't reach it right now", link: null },
    { folder: "x", status: "Git repo, not GitHub", link: null },
    { folder: "y", status: "Not a git repo", link: null }]);
  assert.equal(reposOf({ workspaces: [{ folder: "/p/z", remotes: [{ full_name: "evil.example/x/../y", match: true }] }] })[0].link, null);
  assert.equal(await projectTabsSource(box({ error: { "github.project.detect": { code: "no_such_tool", message: "x" } } }).call).repos("harlow"), null, "a box without GitHub shows no Repos section");
  await s.addRepo("harlow", "acme/new", "work"); await s.addRepo("harlow", "acme/new2", "");
  assert.deepEqual(b.seen.filter((x) => x.tool === "github.project.add-repo").map((x) => x.input), [{ project: "harlow", repo: "acme/new", account: "work" }, { project: "harlow", repo: "acme/new2" }]);
});

test("the tabs: all five for a project with a short name", { skip: !strip }, async () => {
  const { TAB_LABELS } = await import("./tabs-model.ts");
  assert.deepEqual(TAB_LABELS.map(([k]) => k), ["project", "brief", "files", "memory", "team"]);
});
