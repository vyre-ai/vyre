// @ts-check
// container: a folder with a Dockerfile becomes an image in this server's container store (team/contracts/builder.md, the container path). The build runs in a ROOTLESS BuildKit in a container of its
// own (never a host process, never root on the host); it is handed a copy of the folder's files made by the static path's reader (so an .env, a key and .git are not in the build context) and the
// granted build secrets as files; the image comes back as a tar on stdout and is loaded into the container store. What this file decides is pure and tested without Docker: which Dockerfile is allowed,
// which port the app listens on, how the build is asked to run. Running it is `buildImage`, which takes the process runner as an argument.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/** The rootless BuildKit image, pinned by digest (moby/buildkit v0.17.3, resolved 10 Oct 2026). */
export const BUILDKIT = "moby/buildkit:v0.17.3-rootless@sha256:5f1fad127999e9fedfb19edbdd8dbbd5849268b89ff3dc247322730832c25568";
export const BUILD_MS = 15 * 60_000;
/** The largest image tar this reads from the build before it stops it. */
export const IMAGE_MAX = 2 * 1024 ** 3;

const refuse = (/** @type {string} */ message, /** @type {string} */ code = "refused") => Object.assign(new Error(message), { code });

/** One Dockerfile line at a time with its continuations joined and comments dropped. @param {string} text @returns {string[]} */
export function instructions(text) {
  /** @type {string[]} */ const out = [];
  let cur = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!cur && (line === "" || line.startsWith("#"))) continue;
    if (cur && line.startsWith("#")) continue;
    if (line.endsWith("\\")) { cur += line.slice(0, -1) + " "; continue; }
    out.push((cur + line).trim()); cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Is this image reference one a build may start from? Docker Official Images (one name, no registry, `library/x`), `scratch`, an earlier stage of the same Dockerfile, and the prefixes the person
 * allowed in the setting `builder.from` (such as `ghcr.io/vyre-ai/`). A build argument in a name (`$X`) is refused: what it starts from must be read here.
 * @param {string} ref @param {Set<string>} stages @param {string[]} allow
 */
export function fromAllowed(ref, stages, allow) {
  if (/[$]/.test(ref)) return false;
  const bare = ref.toLowerCase();
  if (bare === "scratch" || stages.has(bare)) return true;
  const name = bare.replace(/@sha256:[0-9a-f]{64}$/, "").replace(/:[a-z0-9_][a-z0-9_.-]{0,127}$/, "");
  if (!/^[a-z0-9][a-z0-9._\/-]*$/.test(name)) return false;
  if (/^(?:library\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) return true;
  return allow.some(p => typeof p === "string" && p && bare.startsWith(p.toLowerCase()));
}

/**
 * What a Dockerfile asks of a build: refusals (a frontend the folder names, a base that is not allowed, a build mount from outside), and the port it exposes.
 * @param {string} text @param {{ allow?: string[] }} [o]
 * @returns {{ port: number | null, froms: string[] }}
 */
export function checkDockerfile(text, o = {}) {
  const lines = instructions(text);
  // `# syntax=` names an image that runs AS the build frontend: whoever picks it runs its code in the build, so only the one pinned here is used
  if (/^\s*#\s*syntax\s*=/im.test(String(text).split(/\r?\n/).slice(0, 5).join("\n"))) throw refuse("the Dockerfile names its own build frontend (# syntax=); remove that line", "refused");
  /** @type {Set<string>} */ const stages = new Set();
  /** @type {string[]} */ const froms = [];
  let port = null;
  for (const l of lines) {
    const m = /^(\w+)\s*(.*)$/s.exec(l);
    if (!m) continue;
    const op = m[1].toUpperCase(), rest = m[2];
    if (op === "FROM") {
      const parts = rest.split(/\s+/).filter(p => !p.startsWith("--"));
      const ref = parts[0] || "";
      if (!ref) throw refuse("a FROM line names no image", "refused");
      if (!fromAllowed(ref, stages, o.allow || [])) throw refuse(`the Dockerfile starts from ${ref.slice(0, 80)}, which is not allowed here: use an official image (such as node, python or nginx) or ask the owner to allow its registry`, "refused");
      froms.push(ref);
      const as = /\bAS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(rest);
      if (as) stages.add(as[1].toLowerCase());
    } else if (op === "RUN" || op === "COPY" || op === "ADD") {
      // `COPY --from=<image>` and `RUN --mount=...from=<image>` pull another image into the build: it must pass the same rule as FROM (or be an earlier stage)
      for (const m2 of rest.matchAll(/(?:--from=|\bfrom=)([^\s,]+)/gi)) {
        if (!fromAllowed(m2[1], stages, o.allow || [])) throw refuse(`the Dockerfile takes files from ${m2[1].slice(0, 80)}, which is not allowed here`, "refused");
      }
    } else if (op === "EXPOSE" && port === null) {
      const n = /^(\d{1,5})(?:\/tcp)?\b/i.exec(rest.trim());
      if (n && Number(n[1]) >= 1 && Number(n[1]) <= 65535) port = Number(n[1]);
    }
  }
  if (!froms.length) throw refuse("the Dockerfile has no FROM line", "refused");
  return { port, froms };
}

/**
 * The `docker run` argv that builds: rootless BuildKit as its own non-root user, the context read-only, secrets read-only, nothing else mounted; the image tar goes to stdout.
 * @param {{ ctx: string, secrets?: string, tag: string, secretIds?: string[], buildkit?: string, name?: string }} p
 */
export function buildArgv(p) {
  return ["run", "--rm", "--name", p.name || `vyre-build-${crypto.randomBytes(5).toString("hex")}`,
    "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined", "--cap-drop", "ALL",
    "--memory", "2g", "--cpus", "2", "--pids-limit", "1024",
    "-e", "BUILDKITD_FLAGS=--oci-worker-no-process-sandbox",
    "-v", `${p.ctx}:/ctx:ro`, ...(p.secrets ? ["-v", `${p.secrets}:/bsecrets:ro`] : []),
    "--entrypoint", "buildctl-daemonless.sh", p.buildkit || BUILDKIT,
    "build", "--frontend", "dockerfile.v0", "--local", "context=/ctx", "--local", "dockerfile=/ctx",
    ...(p.secretIds || []).flatMap(id => ["--secret", `id=${id},src=/bsecrets/${id}`]),
    "--output", `type=docker,name=${p.tag}`];
}

/** The secret ids Publish hands the builder (`--secret id=NAME,src=PATH` as argv words or one string), and their host paths. @param {string[]} args @returns {{ id: string, src: string }[]} */
export function secretsOf(args) {
  /** @type {{ id: string, src: string }[]} */ const out = [];
  const words = (args || []).flatMap(a => String(a).split(/\s+/));
  for (let i = 0; i < words.length; i++) {
    const w = words[i] === "--secret" ? words[i + 1] : words[i].startsWith("--secret=") ? words[i].slice(9) : "";
    if (!w) continue;
    const id = /(?:^|,)id=([A-Za-z0-9_.-]{1,64})(?:,|$)/.exec(w), src = /(?:^|,)src=([^,]+)(?:,|$)/.exec(w);
    if (id && src) out.push({ id: id[1], src: src[1] });
  }
  return out;
}

/**
 * A process, with its stdout and stderr captured and bounded. `pipeTo` feeds this process's stdout to another's stdin (the image tar into `docker load`).
 * @param {string[]} argv @param {{ timeoutMs?: number, maxOut?: number }} [o] @returns {import("node:child_process").ChildProcess}
 */
function docker(argv, o = {}) {
  const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
  if (o.timeoutMs) { const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, o.timeoutMs); t.unref?.(); child.on("close", () => clearTimeout(t)); }
  return child;
}

/**
 * Build a folder's files into an image. `run` is the docker runner (default: the docker CLI); tests give a fake.
 * @param {{ files: { path: string, content: Buffer | string }[], tag: string, secretArgs?: string[], buildkit?: string, run?: (argv: string[], o?: { input?: Buffer, timeoutMs?: number }) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   pipeline?: (build: string[], o: { timeoutMs: number, maxBytes: number }) => Promise<{ code: number, stderr: string, loaded: string }> }} p
 * @returns {Promise<{ image: string, logs: string }>}
 */
export async function buildImage(p) {
  const run = p.run || (async (argv, o = {}) => {
    const c = docker(argv, o);
    let out = "", err = "";
    c.stdout?.on("data", d => { if (out.length < 1_000_000) out += d; });
    c.stderr?.on("data", d => { if (err.length < 1_000_000) err += d; });
    if (o.input) c.stdin?.end(o.input); else c.stdin?.end();
    const code = await new Promise(r => { c.on("close", x => r(x ?? 1)); c.on("error", () => r(127)); });
    return { code: Number(code), stdout: out, stderr: err };
  });
  const pipeline = p.pipeline || defaultPipeline;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-build-"));
  try {
    const ctx = path.join(tmp, "ctx");
    fs.mkdirSync(ctx, { recursive: true, mode: 0o755 });
    for (const f of p.files) {
      const to = path.join(ctx, f.path);
      if (!to.startsWith(ctx + path.sep)) throw refuse("a file path leaves the folder", "refused");
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
      fs.writeFileSync(to, f.content, { mode: 0o644 });
    }
    // build secrets: copied to a folder of their own (mode 0644 for the build's non-root user, removed after) and named by id only
    const secrets = secretsOf(p.secretArgs || []);
    let secretsDir = "";
    if (secrets.length) {
      secretsDir = path.join(tmp, "secrets");
      fs.mkdirSync(secretsDir, { mode: 0o755 });
      for (const s of secrets) fs.writeFileSync(path.join(secretsDir, s.id), fs.readFileSync(s.src), { mode: 0o644 });
    }
    const argv = buildArgv({ ctx, secrets: secretsDir, secretIds: secrets.map(s => s.id), tag: p.tag, buildkit: p.buildkit });
    const r = await pipeline(argv, { timeoutMs: BUILD_MS, maxBytes: IMAGE_MAX });
    const lines = r.stderr.split("\n").filter(Boolean);
    const logs = lines.slice(-60).join("\n");
    if (r.code === 127) throw refuse("this server cannot build an image: Docker is not available here", "not_available");
    if (r.code !== 0) throw refuse(`the build failed:\n${lines.slice(-40).join("\n")}`, "build_failed");
    const id = await run(["image", "inspect", p.tag, "--format", "{{.Id}}"]);
    const image = id.stdout.trim();
    if (id.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(image)) throw refuse("the build finished but its image is not in the container store", "build_failed");
    return { image, logs };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The real pipeline: the build's stdout (an image tar, capped) into `docker load`. */
async function defaultPipeline(/** @type {string[]} */ argv, /** @type {{ timeoutMs: number, maxBytes: number }} */ o) {
  const build = docker(argv, { timeoutMs: o.timeoutMs });
  const load = docker(["load"], { timeoutMs: o.timeoutMs });
  let err = "", loaded = "", bytes = 0, over = false;
  build.stderr?.on("data", d => { if (err.length < 1_000_000) err += d; });
  load.stdout?.on("data", d => { loaded += d; });
  load.stderr?.on("data", d => { err += d; });
  build.stdout?.on("data", d => { bytes += d.length; if (bytes > o.maxBytes && !over) { over = true; try { build.kill("SIGKILL"); } catch { /* gone */ } } });
  build.stdout?.pipe(/** @type {any} */ (load.stdin));
  const [bc, lc] = await Promise.all([
    new Promise(r => { build.on("close", x => r(x ?? 1)); build.on("error", () => r(127)); }),
    new Promise(r => { load.on("close", x => r(x ?? 1)); load.on("error", () => r(127)); }),
  ]);
  if (over) return { code: 1, stderr: `${err}\nthe image is larger than ${Math.round(o.maxBytes / 1024 ** 3)} GB`, loaded };
  return { code: Number(bc) || Number(lc), stderr: err, loaded };
}
