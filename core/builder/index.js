// @ts-check
// builder: answers Publish's `builder.build`. Today it reads a folder of ready files (lib/publish/folder-build.js) and runs nothing; a repo, a Drive folder or a build command is refused in plain words
// that name what is missing, never silently skipped. The container builder (BuildKit, core/publish/builder-plan.js) answers the same tool when it exists.

import { readSite, digestOf } from "../../lib/publish/folder-build.js";
import { checkDockerfile, buildImage } from "./container.js";
import { askHelper, helperPresent } from "../../stores/twenty/helper.js";
import { requestText, writeServerFolder, removeServerFolder } from "../../lib/publish/server-folder.js";
import { repoOf, cloneArgs, cloneEnv, tokenShape, TOKEN_ID, CLONE_MAX_BYTES } from "../../lib/publish/repo-source.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Test seam: a stand-in for the image build (the real one needs Docker). */
export const seam = /** @type {{ buildImage: null | typeof buildImage, helper: null | { present: () => boolean, ask: typeof askHelper }, clone: null | ((url: string, branch: string | null, dir: string, token: string | null) => Promise<void>) }} */ ({ buildImage: null, helper: null, clone: null });

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
export const SERVERS_OFF = "Publishing apps with their own server is turned off in this test release. A folder of ready files and a React page still publish.";
const NEEDS_CONTAINER = "this server builds a folder, or a public GitHub repo; a Drive folder needs the container builder, which is not installed here yet";

/** What a deployment asks of a build, and the plain refusal when it is more than this builder does. @param {any} d @returns {{ dir: string, outputDir: string, dockerfile: boolean, synth?: { node: string, command: string, outputDir: string } }} */
export function planOf(d, o = {}) {
  const src = (d && d.source) || {}, b = (d && d.build) || {};
  /** @type {{ url: string, branch: string | null } | null} */ let repo = null;
  if (src.kind === "repo") { const r = repoOf(String(src.ref || "")); if (!r.ok) throw refuse(r.error, "refused"); repo = { url: r.url, branch: r.branch }; }
  else if (src.kind !== "folder") throw refuse(NEEDS_CONTAINER, "refused");
  // A build command (or a node image) runs inside the container builder: a multi-stage Dockerfile Vyre writes (synthDockerfile) builds the site with that command and serves the output as a static server.
  const node = /^node-(\d+)$/.exec(String(b.image || ""));
  if (b.command || node) {
    if (o.servers !== true) throw refuse(SERVERS_OFF, "refused");
    if (b.image && b.image !== "static" && !node) throw refuse(`the ${b.image} image does not build with a command: use a node image (node-20 or node-22)`, "refused");
    if (!b.command) throw refuse(`the ${b.image} image needs a build command to run`, "refused");
    const version = node ? node[1] : "22";
    if (version !== "20" && version !== "22") throw refuse(`node ${version} is not offered: use node-20 or node-22`, "refused");
    return { dir: String(src.ref || ""), outputDir: String(b.output_dir || "dist"), dockerfile: true, ...(repo ? { repo } : {}), synth: { node: version, command: String(b.command), outputDir: String(b.output_dir || "dist") } };
  }
  // Publishing an app with its own server is switched off in this test release until its build network and its Space-plus-name keying are reviewed (trust, rows 37 and 38); static and React sites are not touched.
  if (b.image === "dockerfile" && o.servers !== true) throw refuse(SERVERS_OFF, "refused");
  if (b.image && b.image !== "static" && b.image !== "dockerfile") throw refuse(`the ${b.image} image needs the container builder, which is not installed here yet`, "refused");
  return { dir: String(src.ref || ""), outputDir: String(b.output_dir || "."), dockerfile: b.image === "dockerfile", ...(repo ? { repo } : {}) };
}

/**
 * The Dockerfile for a site built by a command: install and run the command in a node image, then serve the output folder as plain files from busybox's httpd, as nobody, on port 8080.
 * Written by Vyre, never by the person, from three values that were checked: the node version (20 or 22), a one-line command and a relative output folder.
 * @param {{ node: string, command: string, outputDir: string }} s
 */
export function synthDockerfile(s) {
  const out = String(s.outputDir || "dist").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  return [
    `FROM node:${s.node}-alpine AS build`,
    "WORKDIR /app",
    "COPY . .",
    `RUN if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi && ${s.command}`,
    "FROM busybox:stable",
    `COPY --from=build /app/${out} /site`,
    "USER 65534",
    "EXPOSE 8080",
    'CMD ["httpd", "-f", "-p", "8080", "-h", "/site"]',
    "",
  ].join("\n");
}

/** The health a published server is held to unless it names its own: any answer that means the server is up. */
export const HEALTH = Object.freeze({ path: "/", ok: Object.freeze([200, 301, 302, 401, 403, 404]) });

/**
 * A folder with a Dockerfile, built into an image (team/contracts/builder.md, the container path). The folder is read exactly as the static path reads it, so an .env, a key and .git are not in the
 * build context and the same folder is the same version.
 * @param {any} ctx @param {any} d @param {string} dir @param {string[]} secretArgs @param {{ node: string, command: string, outputDir: string }} [synth]
 */
async function containerBuild(ctx, d, dir, secretArgs, synth) {
  let site;
  try { site = readSite({ dir, outputDir: "." }); } catch (/** @type {any} */ e) { throw refuse(e && e.message ? String(e.message) : "the folder could not be read", e && e.code ? String(e.code) : "failed"); }
  let df = site.files.find((/** @type {any} */ f) => f.path === "Dockerfile");
  if (synth) {
    if (df) throw refuse("the folder has its own Dockerfile: remove the build command, or remove the Dockerfile and let Vyre write it", "refused");
    df = { path: "Dockerfile", content: Buffer.from(synthDockerfile(synth)) };
    site = { ...site, files: [...site.files, df].sort((/** @type {any} */ a, /** @type {any} */ b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  } else if (!df) throw refuse("the folder has no Dockerfile at its top; add one, or publish a folder of ready files", "refused");
  const allow = (ctx.config && ctx.config.builder && Array.isArray(ctx.config.builder.from) ? ctx.config.builder.from : []).filter((/** @type {any} */ x) => typeof x === "string");
  const digest = synth ? digestOf(site.files) : site.digest;
  const checked = checkDockerfile(df.content.toString("utf8"), { allow });
  const port = synth || d.job ? 8080 : d.build && Number.isInteger(d.build.port) ? d.build.port : checked.port;
  if (!port) throw refuse("name the port the app listens on: set the build's port, or put an EXPOSE line in the Dockerfile", "refused");
  const tag = `vyre-pub-${String(d.name || "app").replace(/[^a-z0-9-]/g, "")}:${digest.replace(/^sha256:/, "").slice(0, 16)}`;
  // a server that runs its apps through the host helper cannot run Docker here: the helper builds, from a folder this module writes and takes by rename (team/contracts/builder.md)
  const helper = seam.helper || { present: helperPresent, ask: askHelper };
  const built = seam.buildImage ? await seam.buildImage({ files: site.files, tag, secretArgs })
    : helper.present() ? await buildByHelper(ctx, helper, d, site.files, port, secretArgs) : await buildImage({ files: site.files, tag, secretArgs });
  const left = site.skipped.length ? `; left out: ${site.skipped.slice(0, 5).join(", ")}${site.skipped.length > 5 ? ` and ${site.skipped.length - 5} more` : ""}` : "";
  return { digest, files: [], logs: `Built an image from ${site.files.length} file${site.files.length === 1 ? "" : "s"} of ${site.name}${left}.\n${built.logs}`, runtime: { kind: "image", image: built.image, port, health: { path: HEALTH.path, ok: [...HEALTH.ok] }, ...(d.job ? { job: true } : {}) } };
}

/**
 * The host helper's build: the context and the settings go into the deployment's folder under the daemon's publish folder, the helper is asked `pub-build <deployment>` and answers `built <image id>`.
 * @param {any} ctx @param {{ ask: typeof askHelper }} helper @param {any} d @param {{ path: string, content: Buffer }[]} files @param {number} port @param {string[]} secretArgs
 */
export async function buildByHelper(ctx, helper, d, files, port, secretArgs) {
  if (secretArgs && secretArgs.length) throw refuse("build secrets are not supported on a server that builds through its host helper yet; grant the secret for running, not building", "refused");
  const home = ctx.paths && ctx.paths.root;
  if (!home) throw refuse("this server cannot build an image: the daemon's home is not known here: restart Vyre and try again", "not_available");
  const where = { home, space: String(d.space || ""), deployment: String(d.id || "") };
  try {
    writeServerFolder({ ...where, files, request: requestText({ name: String(d.name), version: Number(d.version) || 1, port, memoryMb: 512, cpus: 0.5, pids: 256, health: { path: HEALTH.path, ok: [...HEALTH.ok], startS: 60 }, secrets: [], ...(d.job ? { jobS: d.job.timeout_s } : {}) }) });
    const r = await helper.ask("pub-build", where.deployment, { what: "this site's image", timeoutMs: 20 * 60_000 });
    const id = /^built (sha256:[0-9a-f]{64})$/.exec(String(r.message || "").trim());
    if (!id) throw refuse("the server's host helper built the image but did not say which", "build_failed");
    return { image: id[1], logs: "Built by this server's host helper." };
  } catch (/** @type {any} */ e) {
    if (e && e.code && e.code !== "refused" && e.code !== "not_available") throw refuse(String(e.message || e), e.code === "busy" ? "busy" : "build_failed");
    throw e;
  } finally { removeServerFolder(where); }
}

/** git clone, shallow, of one https GitHub repo into `dir`: no hooks, no prompt, no other protocol, a time limit; with a token only for a private repo. @param {string} url @param {string | null} branch @param {string} dir @param {string | null} token */
async function gitClone(url, branch, dir, token) {
  await new Promise((resolve, reject) => {
    execFile("git", cloneArgs(url, branch, dir), { env: cloneEnv(token), timeout: 120_000, maxBuffer: 1 << 20 }, (err, _out, errText) => {
      if (!err) return resolve(undefined);
      const t = String(errText);
      const closed = /not found|could not read|Authentication failed|terminal prompts disabled|403|401/i.test(t);
      const why = /Remote branch .* not found/i.test(t) ? "that branch is not in the repo"
        : closed && token ? "GitHub did not accept the token for that repo: check that it reaches the repo (repo scope, or Contents read)"
        : closed ? `the repo is not there, or it is private: for a private repo, grant a GitHub token as the build secret ${TOKEN_ID} (publish.secret.grant with use build)`
        : "git could not clone it";
      reject(refuse(`could not get the repo: ${why}; check the owner and name, or publish a folder instead`, "refused"));
    });
  });
}

/**
 * The GitHub token for a private repo, taken out of the build's secrets: the build secret named GITHUB_TOKEN is read for the clone and is never passed on to the image build.
 * @param {string[]} secretArgs `--secret id=NAME,src=FILE` pairs @returns {{ token: string | null, rest: string[] }}
 */
export function takeToken(secretArgs) {
  const rest = []; let token = null;
  for (let k = 0; k < secretArgs.length; k++) {
    const m = secretArgs[k] === "--secret" ? /^id=([^,]+),src=(.+)$/.exec(String(secretArgs[k + 1] || "")) : null;
    if (m && m[1] === TOKEN_ID) {
      let value = ""; try { value = fs.readFileSync(m[2], "utf8").trim(); } catch { /* unreadable: said below */ }
      if (!tokenShape(value)) throw refuse(`the build secret ${TOKEN_ID} is not a GitHub token: grant the token itself (letters, digits, dashes and underscores) and publish again`, "refused");
      token = value; k++; continue;
    }
    rest.push(secretArgs[k]);
  }
  return { token, rest };
}

/** Bytes under a folder (links are not followed). @param {string} dir @returns {number} */
function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); n += e.isDirectory() ? dirBytes(p) : e.isFile() ? fs.statSync(p).size : 0; }
  return n;
}

/** The folder a deployment builds from: its own folder, or a fresh clone of its repo in a folder that `done` removes. @param {any} plan @param {string | null} token @returns {Promise<{ dir: string, done: () => void }>} */
async function sourceDir(plan, token) {
  if (!plan.repo) return { dir: plan.dir, done() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-repo-"));
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  const at = path.join(dir, path.basename(plan.repo.url, ".git"));
  try {
    await (seam.clone || gitClone)(plan.repo.url, plan.repo.branch, at, token);
    if (dirBytes(at) > CLONE_MAX_BYTES) throw refuse(`the repo is more than ${CLONE_MAX_BYTES / 1048576} MB; it was not built: publish a smaller repo, or a folder of what the site needs`, "refused");
  } catch (e) { done(); throw e; }
  return { dir: at, done };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.tool("builder.build", {
      internal: true,
      description: "Build a deployment for Publish: a folder of ready files becomes the site's files and digest. Anything that needs a command is refused with what is missing.",
      callers: ["module"],
      input: { type: "object", properties: { deployment: { type: "object" }, secretArgs: { type: "array", items: { type: "string" } } }, required: ["deployment"] },
      run: async (/** @type {any} */ i) => {
        const plan = planOf(i.deployment, { servers: Boolean(ctx.config && ctx.config.publish && ctx.config.publish.servers === true) });
        const { outputDir, dockerfile, synth } = plan;
        // a private repo's token is a build secret the person granted: read for the clone, and not passed on to the image build
        const { token, rest } = plan.repo ? takeToken(i.secretArgs || []) : { token: null, rest: i.secretArgs || [] };
        const src = await sourceDir(plan, token);
        try {
          const dir = src.dir;
          if (dockerfile) return await containerBuild(ctx, i.deployment, dir, rest, synth);
          let site;
          try { site = readSite({ dir, outputDir }); } catch (/** @type {any} */ e) { throw refuse(e && e.message ? String(e.message) : "the folder could not be read", e && e.code ? String(e.code) : "failed"); }
          // a React page (index.jsx or App.tsx with no index.html) is published as the Preview pane shows it: the previews module makes the page, the compiled files and the libraries it uses
          let files = site.files, built = "";
          if (files.some((/** @type {any} */ f) => /\.(jsx|tsx|ts)$/i.test(f.path))) {
            const r = /** @type {any} */ (await ctx.call("previews.site", { files }));
            if (r && r.error && /^(no_such_tool|not_available)$/.test(String(r.error.code))) throw refuse("a React page needs the previews module, which is not here; publish a folder of ready files instead", "refused");
            if (r && r.error) throw refuse(String(r.error.message || "the page could not be built"), String(r.error.code || "failed"));
            if (r && r.data && r.data.react) { files = r.data.files; built = ` ${r.data.notes.join("; ")}.`; }
          }
          const kb = Math.max(1, Math.round(site.bytes / 1024));
          const left = site.skipped.length ? `; left out: ${site.skipped.slice(0, 5).join(", ")}${site.skipped.length > 5 ? ` and ${site.skipped.length - 5} more` : ""}` : "";
          return { digest: files === site.files ? site.digest : digestOf(files), files, logs: `Read ${site.files.length} file${site.files.length === 1 ? "" : "s"} (${kb} KB) from ${site.name}${left}.${built}`, runtime: { kind: "static" } };
        } finally { src.done(); }
      },
    });
    return { async stop() {} };
  },
};
