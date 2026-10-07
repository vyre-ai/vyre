// @ts-check
// lib/publish/runner.js: what starts the Publish edge. core/publish `publish.edge` writes the compose project; this turns its answer into the ordered `docker` calls and runs
// them through an injected `docker(argv)`. Argument vectors only, never a shell. The Vyre box holds no Docker socket of its own: `docker` is whatever the host gives the edge's
// supervisor, and without one the answer is `not_available` with the plan, so a person can run it by hand.

import path from "node:path";
import { fail } from "./util.js";
import { IMAGES } from "./edge.js";

const PROJECT_RE = /^vyre-publish-spc_[a-z2-7]{12}$/;

/**
 * The calls, in order: build the edge's Caddy image, copy each live static site into its volume, then bring the project up.
 * @param {{ dir: string, compose: { name: string }, fills?: Array<{ docker: string[] }>, build?: { image: string, dockerfile: string } }} edge the answer of `publish.edge`
 * @returns {string[][]}
 */
export function edgePlan(edge) {
  if (!edge || typeof edge.dir !== "string" || !path.isAbsolute(edge.dir) || /[\0\n]/.test(edge.dir)) fail("bad_input", "an absolute edge folder is required");
  const name = edge.compose && edge.compose.name;
  if (typeof name !== "string" || !PROJECT_RE.test(name)) fail("bad_input", "bad project name");
  const image = (edge.build && edge.build.image) || IMAGES.caddy;
  const file = (edge.build && edge.build.dockerfile) || "caddy.Dockerfile";
  if (file !== "caddy.Dockerfile" || image !== IMAGES.caddy) fail("bad_input", "only the edge's own Caddy image is built here");
  const steps = [["build", "-t", image, "-f", path.join(edge.dir, file), edge.dir]];
  for (const f of edge.fills || []) {
    const a = f && f.docker;
    if (!Array.isArray(a) || a[0] !== "run" || a[a.indexOf("--network") + 1] !== "none" || a.indexOf("--network") < 0) fail("bad_input", "a volume fill must run with no network");
    steps.push(a);
  }
  steps.push(["compose", "-p", name, "-f", path.join(edge.dir, "compose.yaml"), "up", "-d", "--remove-orphans"]);
  return steps;
}

/**
 * Run the plan. Stops at the first failing call and says which one; nothing is retried here.
 * @param {string[][]} plan
 * @param {((argv: string[]) => Promise<{ code: number }>) | null | undefined} docker
 */
export async function runPlan(plan, docker) {
  if (typeof docker !== "function") fail("not_available", "this box has no way to start containers; run the plan by hand", { plan });
  /** @type {string[]} */ const done = [];
  for (const argv of plan) {
    const r = await docker(argv);
    if (!r || r.code !== 0) fail("edge_failed", `docker ${argv[0]} failed after ${done.length} step(s)`, { step: argv[0], done: done.length });
    done.push(argv[0]);
  }
  return { steps: done };
}

/** Stop the project: sites stop answering, volumes and certificates stay. @param {string} project @param {(argv: string[]) => Promise<{ code: number }>} docker */
export async function stopEdge(project, docker) {
  if (!PROJECT_RE.test(project)) fail("bad_input", "bad project name");
  const r = await docker(["compose", "-p", project, "stop"]);
  if (!r || r.code !== 0) fail("edge_failed", "docker compose stop failed");
  return { stopped: project };
}
