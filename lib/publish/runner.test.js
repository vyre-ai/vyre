// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { edgePlan, runPlan, stopEdge } from "./runner.js";
import { IMAGES, LOCAL_IMAGES, edgeCompose, caddyDockerfile } from "./edge.js";
import { volumeFill } from "./site-write.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const edge = (extra = {}) => ({ dir: "/h/publish/sp_abc", compose: { name: "vyre-publish-spc_abcdefghijkl" }, fills: [], build: { image: IMAGES.caddy, dockerfile: "caddy.Dockerfile" }, ...extra });
const reject = (fn, code) => assert.throws(fn, e => e.code === code, code);

test("the plan: build the edge image, fill volumes, bring the project up, in that order", () => {
  const dir = "/h/publish/sp1";
  const fill = volumeFill(path.join(dir, "sites", "site-abcdef"), "vyre-publish-spc_abcdefghijkl_site-aa", path.join(dir, "sites"));
  const plan = edgePlan(edge({ dir, fills: [{ docker: fill }] }));
  assert.deepEqual(plan.map(p => p[0]), ["build", "run", "compose"]);
  assert.deepEqual(plan[0].slice(0, 3), ["build", "-t", IMAGES.caddy]);
  assert.ok(plan[2].includes("up") && plan[2].includes("--remove-orphans"));
  assert.ok(plan.flat().every(a => typeof a === "string"));
});

test("the plan refuses a relative folder, a bad project, another image, a fill with a network", () => {
  reject(() => edgePlan(edge({ dir: "rel" })), "bad_input");
  reject(() => edgePlan(edge({ compose: { name: "other" } })), "bad_input");
  reject(() => edgePlan(edge({ build: { image: "evil:1", dockerfile: "caddy.Dockerfile" } })), "bad_input");
  reject(() => edgePlan(edge({ build: { image: IMAGES.caddy, dockerfile: "../x" } })), "bad_input");
  reject(() => edgePlan(edge({ fills: [{ docker: ["run", "--network", "host", "x"] }] })), "bad_input");
  reject(() => edgePlan(edge({ fills: [{ docker: ["run", "--rm", "alpine"] }] })), "bad_input");
});

test("running: stops at the first failure and names it; no docker means not_available with the plan", async () => {
  const plan = [["build"], ["run"], ["compose"]];
  const seen = [];
  assert.deepEqual(await runPlan(plan, async a => { seen.push(a[0]); return { code: 0 }; }), { steps: ["build", "run", "compose"] });
  seen.length = 0;
  await assert.rejects(runPlan(plan, async a => { seen.push(a[0]); return { code: a[0] === "run" ? 1 : 0 }; }), e => e.code === "edge_failed" && e.detail.done === 1);
  assert.deepEqual(seen, ["build", "run"]);
  await assert.rejects(runPlan(plan, null), e => e.code === "not_available" && e.detail.plan === plan);
});

test("stop: only a Publish project", async () => {
  assert.deepEqual(await stopEdge("vyre-publish-spc_abcdefghijkl", async () => ({ code: 0 })), { stopped: "vyre-publish-spc_abcdefghijkl" });
  await assert.rejects(stopEdge("vyre", async () => ({ code: 0 })), e => e.code === "bad_input");
});

// Every image Docker would pull is a digest (user decision: pinned, not tags that move).
const DIGEST = /@sha256:[0-9a-f]{64}$/;
test("Publish images: everything pulled is pinned by digest; only the locally built Caddy is a tag", () => {
  for (const [k, v] of Object.entries(IMAGES)) if (!LOCAL_IMAGES.includes(v)) assert.match(v, DIGEST, `IMAGES.${k}`);
  const c = edgeCompose({ id: "spc_abcdefghijkl", name: "northwind.vyre.run" }, []);
  for (const [n, s] of Object.entries(c.services)) if (!LOCAL_IMAGES.includes(s.image)) assert.match(s.image, DIGEST, `service ${n}`);
  reject(() => edgeCompose({ id: "spc_abcdefghijkl", name: "northwind.vyre.run" }, [], { images: { buildkit: "moby/buildkit:latest" } }), "bad_input");
  for (const l of caddyDockerfile().split("\n").filter(l => /^FROM /.test(l))) assert.match(l.split(" ")[1], DIGEST, l);
  assert.match(volumeFill("/a/sites/site-abcdef", "vyre-publish-x_site-aa", "/a/sites").find(a => a.startsWith("alpine")), DIGEST);
});

// The repo's own container files: any image reference that is not ours must carry a digest.
const OWN = /^(ghcr\.io\/vyre-ai\/vyre|vyre|vyre-publish-caddy)(:|@|$)/;
// Shipped files only: scripts/ (the e2e harness) and spike/ folders are throwaway test rigs that never reach a person's box.
const NOT_SHIPPED = new Set(["node_modules", ".git", "dist", "scripts", "spike"]);
function containerFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SHIPPED.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) containerFiles(f, out);
    else if (/(^|\.)Dockerfile$|^Dockerfile\.|^compose[^/]*\.ya?ml$|^docker-compose[^/]*\.ya?ml$/.test(e.name)) out.push(f);
  }
  return out;
}
export function unpinned(text) {
  const refs = [];
  const stages = new Set();
  for (const m of text.matchAll(/^FROM\s+(?:--\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) { if (!stages.has(m[1])) refs.push(m[1]); if (m[2]) stages.add(m[2]); }
  for (const m of text.matchAll(/^COPY\s+--from=(\S+)/gim)) if (!stages.has(m[1]) && !/^\d+$/.test(m[1])) refs.push(m[1]);
  for (const m of text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) refs.push(m[1]);
  return refs.filter(r => r !== "scratch" && !/^\$\{[A-Z_]+\}$/.test(r)).map(r => r.replace(/^\$\{[A-Z_]+:-(.*)\}$/, "$1")).filter(r => !OWN.test(r) && !DIGEST.test(r));
}
test("the repo's container files: no image reference without a digest", () => {
  const files = containerFiles(ROOT);
  assert.ok(files.length >= 4, "found the container files");
  const bad = files.flatMap(f => unpinned(fs.readFileSync(f, "utf8")).map(r => `${path.relative(ROOT, f)}: ${r}`));
  assert.deepEqual(bad, []);
  assert.deepEqual(unpinned("FROM node:22\nFROM a@sha256:" + "a".repeat(64) + " AS b\nCOPY --from=b /x /y\nCOPY --from=nginx:1 /x /y"), ["node:22", "nginx:1"]);
  assert.deepEqual(unpinned("services:\n  a:\n    image: ${X:-redis:7}\n  b:\n    image: ghcr.io/vyre-ai/vyre:latest"), ["redis:7"]);
});
