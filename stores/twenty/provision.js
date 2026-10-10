// @ts-check
// Per-Space provisioning of Twenty (spec 3.7, R5-15): one Twenty per Space with its own Postgres,
// Redis and secrets; no published port; an internal network with no way out; a service user and one
// API key made by script, no browser; the instance admin credential used here and kept out of the
// running gateway; the front end replaced by an empty directory.
//
// Everything that touches the machine goes through a `runner` (docker, files), so the whole thing is
// tested without Docker. testbox runs it for real (stores/twenty/live).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";

export const TWENTY_IMAGE = "twentycrm/twenty";
/** The release this build was tested against. Upgrades are explicit. */
export const TWENTY_TESTED_TAG = "v2.44.0";
// Every image is named by tag AND digest (a tag can be moved at the registry; the digest cannot). These are the exact images stores/twenty/live passes against (5 Oct 2026).
/** The Twenty image reference a Space runs: tag and digest. An upgrade names a full reference like this, never a bare tag. */
export const TWENTY_TESTED_REF = `${TWENTY_IMAGE}:${TWENTY_TESTED_TAG}@sha256:01fb6d2c00397976fd7613dbeb9703b514b52fb6270339b7a326a2a975d15b26`;
export const POSTGRES_IMAGE = "postgres:16.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c";
/** The loopback proxy a Mac server publishes Twenty through (alpine/socat 1.8.0.3, index digest: linux arm64 and amd64). Twenty itself never gets a published port or an outbound network. */
export const PROXY_IMAGE = "alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e";
export const REDIS_IMAGE = "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499";
/** Is this a full, pinned image reference: name, tag and sha256 digest? @param {unknown} r */
export const isPinnedRef = r => typeof r === "string" && /^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}$/.test(r);
/** The tag of a pinned reference, for file names and messages. @param {string} r */
export const tagOfRef = r => String(r).split("@")[0].split(":").pop() || "unknown";

/** @param {string} space */
export const SPACE_RE = /^[a-z][a-z0-9-]{0,30}$/;
const need = (/** @type {string} */ space) => { if (!SPACE_RE.test(space)) throw new Error(`A space name is lowercase letters, digits and dashes: ${space}`); };

/** The names a Space's Twenty uses on the machine. @param {string} space */
export function names(space) {
  need(space);
  return { project: `vyre-${space}-twenty`, network: `vyre-${space}-twenty_store`, serverAlias: `twenty-${space}`, gatewayAlias: `vyre-${space}`, volumes: { db: `vyre-${space}-twenty_db-data`, files: `vyre-${space}-twenty_server-data` } };
}

/**
 * Memory limits in MB for one Space's four containers. `small` is for a Space on a small box (a few people, a few thousand
 * records): it is measured, not guessed (see team/archive/work-journals/records.md for the runs). `standard` leaves Docker's default (none).
 * A caller may give its own numbers.
 */
export const MEMORY_PROFILES = Object.freeze({
  // `tiny` is for ONE Space on a 4 GB server (the person never picks it: "auto" chooses by the machine's memory). Lower server and worker caps than `small`; a Node heap is set at 70% of each cap.
  // measured on a real Twenty in a 3 GB cgroup (the stack of a 4 GB server less the OS and the daemon): no restart or kill, container peaks server 1196, worker 892, db 109, redis 25 = 2221 MB. The caps sit at the peaks, so
  // there is no headroom beyond the swap the helper turns on. (1024 and 640 crash-looped the worker.)
  tiny: Object.freeze({ server: 1200, worker: 900, db: 192, redis: 64 }),
  small: Object.freeze({ server: 1536, worker: 1024, db: 256, redis: 96 }),
  standard: null,
});
/** Under this much total memory (MB) a Space gets the `tiny` profile, and a Linux server with no swap gets some. */
export const TINY_BELOW_MB = 6144;
/** The profile a machine of `totalMb` gets when nothing says otherwise: tiny under about 6 GB, small above. The person never sees a setting. @param {number} totalMb @returns {"tiny" | "small"} */
export const autoProfile = (totalMb) => (Number.isFinite(totalMb) && totalMb > 0 && totalMb < TINY_BELOW_MB ? "tiny" : "small");
/** @param {string | { server: number, worker: number, db: number, redis: number } | null | undefined} m @param {number} [totalMb] the machine's memory for "auto" (the running machine's by default) */
export function memoryOf(m, totalMb = os.totalmem() / 1048576) {
  if (m === undefined || m === null) return null;
  if (m === "auto") return MEMORY_PROFILES[autoProfile(totalMb)];
  if (typeof m === "string") { if (!(m in MEMORY_PROFILES)) throw new Error(`memory is one of auto, ${Object.keys(MEMORY_PROFILES).join(", ")} or four numbers`); return /** @type {any} */ (MEMORY_PROFILES)[m]; }
  for (const k of ["server", "worker", "db", "redis"]) if (!Number.isInteger(/** @type {any} */ (m)[k]) || /** @type {any} */ (m)[k] < 32) throw new Error(`memory.${k} is whole megabytes, at least 32`);
  return m;
}

/**
 * The compose file for one Space. Pure. Nothing here publishes a port and the network is internal, except on a Mac server (`publish: "loopback"`): there a proxy container
 * on a second, ordinary network publishes the server's port on 127.0.0.1 only, at TWENTY_HOST_PORT from .env. Twenty itself keeps the internal network alone (no outbound,
 * no published port), because Docker cannot publish a port from an internal network, and a Mac's host cannot reach container addresses inside Colima's VM.
 * `memory` caps each container (a Node heap is set below its container's limit so it collects before the kernel kills it).
 * `golden`: a new Space starts from a saved, already migrated database (see findGolden): a one-shot `restore` service loads ./golden.dump into the empty database before the server starts, so the server's
 * first boot runs no migrations. It is in the compose file only for that first start. `migrated` (also implied by `golden`) keeps the server from running the migration steps at every start: they take
 * about 30 s each and the database is already at this image's version. An upgrade writes the compose file without it, so its first start does migrate.
 * @param {{ space: string, image?: string, hookPort?: number, publish?: "loopback", golden?: boolean, migrated?: boolean, memory?: Parameters<typeof memoryOf>[0], totalMb?: number }} o `totalMb` is the machine's memory for the "auto" profile (the root helper passes the host's, since it runs this in a container). `image` is a full pinned reference (tag and digest)
 */
export function composeFile(o) {
  const n = names(o.space);
  const image = o.image ?? TWENTY_TESTED_REF;
  if (!isPinnedRef(image)) throw new Error(`The Twenty image must be a full reference with a digest (name:tag@sha256:...), not ${String(image).slice(0, 80)}`);
  const env = [
    "NODE_PORT: 3000",
    "PG_DATABASE_URL: postgres://postgres:${PG_PASSWORD}@db:5432/default",
    "REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379",
    `SERVER_URL: http://${n.serverAlias}:3000`,
    "APP_SECRET: ${APP_SECRET}",
    "ENCRYPTION_KEY: ${ENCRYPTION_KEY}",
    `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS: ${n.gatewayAlias}`,
    'API_RATE_LIMITING_SHORT_LIMIT: "2000"',
    'API_RATE_LIMITING_LONG_LIMIT: "100000"',
    'DISABLE_CRON_JOBS_REGISTRATION: "true"',
    'IS_EMAIL_VERIFICATION_REQUIRED: "false"',
    'IS_MULTIWORKSPACE_ENABLED: "false"',
  ];
  const mem = memoryOf(o.memory, o.totalMb);
  const heap = (/** @type {number} */ mb) => `NODE_OPTIONS: "--max-old-space-size=${Math.max(96, Math.floor(mb * 0.7))}"`;
  const envBlock = (extra = [], /** @type {number | undefined} */ mb = undefined) => [...env, ...(mem && mb ? [heap(mb)] : []), ...extra].map((l) => `      ${l}`).join("\n");
  // on the tiny profile a container may spill half its cap into the server's swap (the helper turns swap on for a small server); every other profile has none
  const swapOf = (/** @type {number} */ mb) => (mem === MEMORY_PROFILES.tiny ? mb + Math.floor(mb / 2) : mb);
  const cap = (/** @type {number | undefined} */ mb) => (mem && mb ? `\n    mem_limit: ${mb}m\n    memswap_limit: ${swapOf(mb)}m` : "");
  return `# Generated by Vyre for the space "${o.space}". Do not edit: provisioning rewrites this file.
name: ${n.project}
services:
  server:
    image: \${TWENTY_IMAGE_REF:-${image}}
    restart: unless-stopped${cap(mem?.server)}
    networks:
      store:
        aliases: [${n.serverAlias}]
    volumes:
      - server-data:/app/packages/twenty-server/.local-storage
      - ./empty-front:/app/packages/twenty-server/dist/front:ro
    environment:
${envBlock(o.golden || o.migrated ? ['DISABLE_DB_MIGRATIONS: "true"'] : [], mem?.server)}
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }${o.golden ? "\n      restore: { condition: service_completed_successfully }" : ""}
    healthcheck: { test: "curl --fail http://localhost:3000/healthz", interval: 5s, timeout: 5s, retries: 80, start_period: 900s }
  worker:
    image: \${TWENTY_IMAGE_REF:-${image}}
    restart: unless-stopped
    command: ["yarn", "worker:prod"]${cap(mem?.worker)}
    networks: [store]
    volumes:
      - server-data:/app/packages/twenty-server/.local-storage
    environment:
${envBlock(['DISABLE_DB_MIGRATIONS: "true"'], mem?.worker)}
    depends_on:
      server: { condition: service_healthy }
  db:
    image: ${POSTGRES_IMAGE}
    restart: unless-stopped${cap(mem?.db)}${mem ? `\n    command: ["postgres", "-c", "shared_buffers=${Math.floor(mem.db / 4)}MB", "-c", "max_connections=60", "-c", "work_mem=4MB"]` : ""}
    networks: [store]
    volumes: [db-data:/var/lib/postgresql/data]
    environment: { POSTGRES_DB: default, POSTGRES_USER: postgres, POSTGRES_PASSWORD: "\${PG_PASSWORD}" }
    healthcheck: { test: "pg_isready -U postgres -h localhost -d default", interval: 5s, timeout: 5s, retries: 20 }
${o.golden ? `  restore:
    image: ${POSTGRES_IMAGE}
    restart: "no"
    networks: [store]
    volumes:
      - \${GOLDEN_DUMP:-./golden.dump}:/golden.dump:ro
    environment: { PGPASSWORD: "\${PG_PASSWORD}", ADMIN_PASSWORD: "\${ADMIN_PASSWORD}" }
    entrypoint: ["sh", "-c", "set -e; if [ -n \\"$$(psql -h db -U postgres -d default -tAc \\"select to_regclass('public.vyre_golden')\\")\\" ]; then exit 0; fi; pg_restore -h db -U postgres -d default --clean --if-exists --no-owner --no-acl --exit-on-error /golden.dump; psql -h db -U postgres -d default -v ON_ERROR_STOP=1 <<'SQL'\\n\\\\set pw \`printenv ADMIN_PASSWORD\`\\n-- nothing the saved database holds may be shared by two Spaces: its signing key, tokens, sessions, keys, invite hash and app secret go; the saved user gets this Space's own password\\nDELETE FROM core.\\"signingKey\\";\\nDELETE FROM core.\\"appToken\\";\\nDELETE FROM core.\\"userSession\\";\\nDELETE FROM core.\\"roleTarget\\" WHERE \\"apiKeyId\\" IS NOT NULL;\\nDELETE FROM core.\\"apiKey\\";\\nUPDATE core.\\"applicationRegistration\\" SET \\"oAuthClientSecretHash\\" = encode(sha256(gen_random_uuid()::text::bytea), 'hex');\\nUPDATE core.workspace SET \\"isPasswordAuthEnabled\\" = true, \\"inviteHash\\" = gen_random_uuid()::text;\\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\\nUPDATE core.\\"user\\" SET \\"passwordHash\\" = crypt(:'pw', gen_salt('bf', 10));\\nDROP EXTENSION pgcrypto;\\n-- the mark that this restore finished: a start that finds it does nothing, a start that finds a half restore (no mark) restores over it\\nCREATE TABLE public.vyre_golden (at timestamptz NOT NULL DEFAULT now());\\nINSERT INTO public.vyre_golden DEFAULT VALUES;\\nSQL"]
    depends_on:
      db: { condition: service_healthy }
` : ""}  redis:
    image: ${REDIS_IMAGE}
    restart: unless-stopped${cap(mem?.redis)}
    networks: [store]
    command: ["redis-server", "--maxmemory-policy", "noeviction"${mem ? `, "--maxmemory", "${Math.floor(mem.redis * 0.75)}mb"` : ""}, "--requirepass", "\${REDIS_PASSWORD}"]
    healthcheck: { test: ["CMD-SHELL", "redis-cli -a \\"$$REDIS_PASSWORD\\" ping | grep PONG"], interval: 5s, timeout: 5s, retries: 20 }
    environment: { REDIS_PASSWORD: "\${REDIS_PASSWORD}" }
${o.publish === "loopback" ? `  proxy:
    image: ${PROXY_IMAGE}
    restart: unless-stopped
    command: ["TCP-LISTEN:3000,fork,reuseaddr", "TCP:server:3000"]
    networks: [store, publish]
    ports:
      - "127.0.0.1:\${TWENTY_HOST_PORT:?}:3000"
    depends_on:
      server: { condition: service_healthy }
` : ""}networks:
  store:
    internal: true
${o.publish === "loopback" ? "  publish: {}\n" : ""}volumes:
  db-data:
    name: ${n.volumes.db}
  server-data:
    name: ${n.volumes.files}
`;
}

/**
 * The firewall rules the box applies for this Space (an owner-based rule: agent uids cannot open a
 * connection to the store network). Returned as text for the box's own firewall step; the provisioning
 * test only checks they are generated, since applying them needs root on the box.
 * @param {{ space: string, subnet: string, agentUidMin?: number }} o
 */
export function firewallRules(o) {
  need(o.space);
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(o.subnet)) throw new Error("subnet looks like 172.30.4.0/24");
  const min = o.agentUidMin ?? 2000;
  return [
    `# vyre ${o.space}: agents cannot reach this Space's Twenty, and Twenty cannot reach out`,
    `iptables -I OUTPUT -d ${o.subnet} -m owner --uid-owner ${min}-4294967294 -j REJECT`,
    `iptables -I DOCKER-USER -s ${o.subnet} ! -d ${o.subnet} -j DROP`,
    `iptables -I DOCKER-USER -d ${o.subnet} -m owner --uid-owner ${min}-4294967294 -j REJECT`,
  ].join("\n") + "\n";
}

/**
 * @typedef {{ exec: (cmd: string, args: string[], opts?: { cwd?: string, input?: string }) => Promise<{ stdout: string, stderr: string }>,
 *   fetch: typeof fetch, sleep: (ms: number) => Promise<void> }} Runner
 */
/** The real runner: docker on this machine. `env` is the environment docker runs with (a Mac server names Colima's socket in DOCKER_HOST); default this process's. @param {{ env?: Record<string, string | undefined> }} [ro] @returns {Runner} */
export function realRunner(ro = {}) {
  return {
    exec: (cmd, args, opts = {}) => new Promise((resolve, reject) => {
      const p = execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, ...(ro.env ? { env: /** @type {any} */ (ro.env) } : {}) }, (err, stdout, stderr) => (err ? reject(Object.assign(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${String(stderr || err.message).slice(0, 400)}`), { stdout, stderr })) : resolve({ stdout, stderr })));
      if (opts.input) p.stdin?.end(opts.input);
    }),
    fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const secret = (/** @type {number} */ n) => crypto.randomBytes(n).toString("hex");
/** @param {string} file @param {string} text */
const writePrivate = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); fs.chmodSync(file, 0o600); };

/** Where a Space's Twenty keeps its files. @param {string} home @param {string} space */
export function spaceDir(home, space) { need(space); return path.join(home, "spaces", space, "twenty"); }

/**
 * @typedef {{ home: string, space: string, runner?: Runner, image?: string, gatewayContainer?: string | null,
 *   reach?: "alias" | "ip" | "loopback", publish?: "loopback", pickPort?: () => Promise<number>, memory?: Parameters<typeof memoryOf>[0], log?: (line: string) => void,
 *   golden?: false | { dump: string, meta: GoldenMeta }, onPhase?: (name: string) => void }} ProvisionOptions
 * @typedef {{ image: string, email: string, workspaceId: string, builtAt: string, sha256: string, state?: Record<string, any> }} GoldenMeta
 * @typedef {{ space: string, dir: string, url: string, origin: string, keyFile: string, workspaceId: string, network: string,
 *   serverAlias: string, gatewayAlias: string, webhookSecretFile: string, image: string, port?: number }} Provisioned
 */

/**
 * Bring a Space's Twenty up and make its one service credential. Idempotent on a Space that is already
 * provisioned (returns what is on disk). The instance admin credential lives in admin.secret (0600), read
 * only by provisioning and upgrade, never by the gateway.
 * @param {ProvisionOptions} o @returns {Promise<Provisioned>}
 */
export async function provisionSpace(o) {
  const n = names(o.space);
  const runner = o.runner ?? realRunner();
  const log = o.log ?? (() => {});
  const dir = spaceDir(o.home, o.space);
  const image = o.image ?? TWENTY_TESTED_REF;
  if (!isPinnedRef(image)) throw new Error(`The Twenty image must be a full reference with a digest (name:tag@sha256:...), not ${String(image).slice(0, 80)}`);
  const keyFile = path.join(dir, "service.key");
  const origin = `http://${n.serverAlias}:3000`;
  const base = { space: o.space, dir, origin, keyFile, network: n.network, serverAlias: n.serverAlias, gatewayAlias: n.gatewayAlias, webhookSecretFile: path.join(dir, "webhook.secret"), image };
  // a Space already made: the image its env file names must be a full pinned reference, or it is refused at start (the same rule as an upgrade)
  try { const named = /^TWENTY_IMAGE_REF=(.*)$/m.exec(fs.readFileSync(path.join(dir, ".env"), "utf8"))?.[1]; if (named !== undefined && !isPinnedRef(named)) throw new Error(`This Space's env file names the Twenty image without a digest (${named.slice(0, 80)}): refusing to start it`); }
  catch (e) { if (/** @type {any} */ (e)?.code !== "ENOENT") throw e; }
  if (fs.existsSync(keyFile) && fs.existsSync(path.join(dir, "workspace.id"))) {
    if (o.onPhase) o.onPhase("reach");
    const url = await reachUrl(o, runner, n, origin);
    const rp = o.reach === "loopback" ? readLoopbackPort(dir) : 0;
    return { ...base, url, workspaceId: fs.readFileSync(path.join(dir, "workspace.id"), "utf8").trim(), ...(rp ? { port: rp } : {}) };
  }
  fs.mkdirSync(path.join(dir, "empty-front"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true, mode: 0o700 });
  const loopback = o.publish === "loopback";
  const port = loopback ? await (o.pickPort ?? pickLoopbackPort)() : 0;
  // A saved, already migrated database for this image (built by stores/twenty/live/build-golden.mjs): the Space starts from it, which skips the server's first-boot migrations and the first define of the
  // core types. The saved user's password is replaced in the restore step by this Space's own, so nothing shared stays valid.
  // On a server the compose file that runs is root's own (the Space helper regenerates and lints it): the dump is root's to take out of the image and the password root's to make and hand back, so
  // here, with a runner that can ask for it (`adminPassword`), none of that is written. Whether root used the saved database is known only once the Space is up: if it did not, this is a plain Space.
  const golden = o.golden === false ? null : o.golden ?? findGolden({ image });
  const viaHelper = typeof /** @type {any} */ (runner).adminPassword === "function";
  const localGolden = Boolean(golden) && !viaHelper;
  const adminPass = secret(24);
  writePrivate(path.join(dir, ".env"), `TWENTY_IMAGE_REF=${image}\nPG_PASSWORD=${secret(16)}\nREDIS_PASSWORD=${secret(16)}\nAPP_SECRET=${secret(32)}\nENCRYPTION_KEY=${secret(32)}\n${localGolden ? `ADMIN_PASSWORD=${adminPass}\n` : ""}${loopback ? `TWENTY_HOST_PORT=${port}\n` : ""}`);
  if (localGolden && golden) { fs.copyFileSync(golden.dump, path.join(dir, "golden.dump")); fs.chmodSync(path.join(dir, "golden.dump"), 0o600); }
  writePrivate(path.join(dir, "compose.yml"), composeFile({ space: o.space, image, memory: o.memory, ...(localGolden ? { golden: true } : {}), ...(loopback ? { publish: "loopback" } : {}) }));
  if (loopback) writePrivate(path.join(dir, "reach.json"), JSON.stringify({ host: "127.0.0.1", port, at: new Date().toISOString() }));
  if (o.memory !== undefined) writePrivate(path.join(dir, "memory.json"), JSON.stringify(o.memory));
  writePrivate(path.join(dir, "webhook.secret"), secret(24));
  // Each phase is timed and logged, so a slow create says which part is slow (the screen that waits on this shows the same phases).
  const phase = async (/** @type {string} */ name, /** @type {() => Promise<any>} */ fn) => { const t = Date.now(); if (o.onPhase) o.onPhase(name); log(`phase ${name}: started`); const r = await fn(); log(`phase ${name}: ${((Date.now() - t) / 1000).toFixed(1)}s`); return r; };
  await phase("pull images", () => runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "pull", "--quiet"], { cwd: dir }));
  await phase("start database and cache", () => runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait", "db", "redis"], { cwd: dir }));
  await phase(localGolden ? "start Records (saved database, first healthy answer)" : "start Records (migrations, first healthy answer)", () => runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait"], { cwd: dir }));
  if (o.gatewayContainer) await runner.exec("docker", ["network", "connect", "--alias", n.gatewayAlias, n.network, o.gatewayContainer]).catch((e) => { if (!/already exists/i.test(String(e.message))) throw e; });
  const url = await reachUrl(o, runner, n, origin);
  await waitHealthy(runner, url);
  log("creating the service user, workspace and key");
  // The password this Space's saved user has: this side made it (a runner that runs compose itself), or root did and left it for this uid alone (a server). None left: root did not use the saved database.
  let usedGolden = localGolden, adminPassword = adminPass;
  if (golden && viaHelper) { const hp = await /** @type {any} */ (runner).adminPassword(); if (typeof hp === "string" && hp) { usedGolden = true; adminPassword = hp; } else log("the server started this Space without the saved database"); }
  log(usedGolden ? "starting from the saved database" : "no saved database for this image: Records migrate from scratch (a few minutes)");
  const adminEmail = usedGolden && golden ? golden.meta.email : `service@${o.space}.vyre.invalid`;
  if (usedGolden && golden) {
    // what the store knows of the saved types (its own plans, which types have their mirror columns): the new Space starts knowing it, so its first define finds nothing to do
    for (const [f, v] of Object.entries(golden.meta.state ?? {})) if (/^[a-z-]+\.json$/.test(f)) writePrivate(path.join(dir, "state", f), JSON.stringify(v));
  }
  writePrivate(path.join(dir, "admin.secret"), JSON.stringify({ email: adminEmail, password: adminPassword }));
  const r = usedGolden
    ? await phase("workspace and key (from the saved database)", () => adoptGolden({ runner, url, origin, email: adminEmail, password: adminPassword, displayName: o.space }))
    : await phase("workspace and key", () => bootstrap({ runner, url, origin, email: adminEmail, password: adminPassword, displayName: o.space }));
  if (localGolden) {
    // the restore step belongs to the first start only: the dump goes, and the compose file no longer names it
    fs.rmSync(path.join(dir, "golden.dump"), { force: true });
    writePrivate(path.join(dir, "compose.yml"), composeFile({ space: o.space, image, memory: o.memory, migrated: true, ...(loopback ? { publish: "loopback" } : {}) }));
  }
  writePrivate(keyFile, r.apiKey);
  writePrivate(path.join(dir, "key.json"), JSON.stringify({ apiKeyId: r.apiKeyId, expiresAt: r.expiresAt, createdAt: new Date().toISOString() }));
  writePrivate(path.join(dir, "workspace.id"), r.workspaceId);
  return { ...base, url, workspaceId: r.workspaceId, ...(loopback ? { port } : {}) };
}

/**
 * Where a saved database for an image is kept: `<tag>.dump` (pg_dump custom format, no owners) and `<tag>.json` ({ image, email, workspaceId, builtAt, sha256 of the dump }) in one folder. The folders looked in,
 * in order: VYRE_TWENTY_GOLDEN_DIR, then stores/twenty/golden in this checkout. The file is only used when its image is exactly the one the Space will run.
 * @param {{ image: string, dirs?: string[] }} o @returns {{ dump: string, meta: GoldenMeta } | null}
 */
export function findGolden(o) {
  const tag = tagOfRef(o.image);
  const dirs = o.dirs ?? [process.env.VYRE_TWENTY_GOLDEN_DIR, new URL("./golden", import.meta.url).pathname].filter((/** @type {any} */ d) => typeof d === "string" && d);
  for (const d of dirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(d, `${tag}.json`), "utf8"));
      const dump = path.join(d, `${tag}.dump`);
      // Used only when it is for exactly this image (tag and digest) AND the dump is the file the build hashed: a dump that was changed, cut short or swapped is not a saved database.
      if (meta && meta.image === o.image && typeof meta.email === "string" && /^[0-9a-f]{64}$/.test(String(meta.sha256)) && sha256File(dump) === meta.sha256) return { dump, meta };
    } catch { /* not here */ }
  }
  return null;
}

/** The table the Space helper asks for to know a Space's database was migrated (box/vyre sp_schema: `select to_regclass($$core."user"$$)`). The golden build checks the pinned image still has it. */
export const CORE_USER_TABLE = 'core."user"';
export const CORE_USER_PROBE = `select to_regclass($$${CORE_USER_TABLE}$$)`;

/** The sha256 of a file, hex. @param {string} f */
const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/**
 * A Space started from the saved database already has its user and workspace, and the restore step has put this Space's own password on the user: sign in with it, make this Space's API key and name the
 * workspace for the Space. The saved database's old key is signed with another secret and is dead.
 * @param {{ runner: Runner, url: string, origin: string, email: string, password: string, displayName: string }} o
 */
export async function adoptGolden(o) {
  const gq = async (/** @type {string} */ query, /** @type {string | undefined} */ token) => {
    const res = await o.runner.fetch(`${o.url}/metadata`, { method: "POST", headers: { "content-type": "application/json", origin: o.origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }) });
    const j = /** @type {any} */ (await res.json());
    if (j.errors) throw new Error(`Records could not start from the saved database: ${String(j.errors[0]?.message).slice(0, 200)}`);
    return j.data;
  };
  const q = (/** @type {string} */ x) => JSON.stringify(x);
  const lt = await gq(`mutation Adopt_loginToken { getLoginTokenFromCredentials(email: ${q(o.email)}, password: ${q(o.password)}, origin: ${q(o.origin)}) { loginToken { token } } }`);
  const tk = await gq(`mutation Adopt_login { getAuthTokensFromLoginToken(loginToken: ${q(lt.getLoginTokenFromCredentials.loginToken.token)}, origin: ${q(o.origin)}) { tokens { accessOrWorkspaceAgnosticToken { token } } } }`);
  const access = tk.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
  const me = await gq("query Adopt_ws { currentWorkspace { id } }", access);
  const roles = await gq("query Adopt_roles { getRoles { id label } }", access);
  const role = roles.getRoles.find((/** @type {any} */ r) => r.label === "Admin") ?? roles.getRoles[0];
  const exp = new Date(Date.now() + 365 * 864e5).toISOString();
  const ak = await gq(`mutation Adopt_key { createApiKey(input: { name: "vyre-gateway", expiresAt: ${q(exp)}, roleId: ${q(role.id)} }) { id } }`, access);
  const tok = await gq(`mutation Adopt_token { generateApiKeyToken(apiKeyId: ${q(ak.createApiKey.id)}, expiresAt: ${q(exp)}) { token } }`, access);
  await gq(`mutation Adopt_name { updateWorkspace(data: { displayName: ${q(o.displayName)} }) { id } }`, access).catch(() => {});
  return { workspaceId: me.currentWorkspace.id, apiKey: tok.generateApiKeyToken.token, apiKeyId: ak.createApiKey.id, expiresAt: exp };
}

/** The host port a Mac Space's Twenty is published on (127.0.0.1 only), as recorded in its reach.json. @param {string} dir */
export function readLoopbackPort(dir) {
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, "reach.json"), "utf8")).port; return Number.isInteger(p) && p > 1023 && p < 65536 ? p : 0; } catch { return 0; }
}

/** A free port on 127.0.0.1 in the dynamic range, picked at random. @returns {Promise<number>} */
export async function pickLoopbackPort() {
  for (let i = 0; i < 40; i++) {
    const port = 49152 + crypto.randomInt(0, 16000);
    const ok = await new Promise(resolve => { const srv = net.createServer(); srv.once("error", () => resolve(false)); srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true))); });
    if (ok) return port;
  }
  throw new Error("Could not find a free port on 127.0.0.1");
}

/** @param {ProvisionOptions} o @param {Runner} runner @param {ReturnType<typeof names>} n @param {string} origin */
async function reachUrl(o, runner, n, origin) {
  if ((o.reach ?? "alias") === "alias") return origin;
  if (o.reach === "loopback") {
    // A Mac server: Twenty is published on 127.0.0.1 only, through the proxy, at the port recorded when the Space was provisioned.
    const port = readLoopbackPort(spaceDir(o.home, o.space));
    if (!port) throw new Error("This Space's loopback port is not recorded");
    return `http://127.0.0.1:${port}`;
  }
  const out = await runner.exec("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${n.network}").IPAddress}}`, `${n.project}-server-1`]);
  const ip = out.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("Could not find the Records server's address on its network");
  return `http://${ip}:3000`;
}

/** @param {Runner} runner @param {string} url */
async function waitHealthy(runner, url, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const r = await runner.fetch(`${url}/healthz`); if (r.ok) return; } catch { /* not up yet */ }
    await runner.sleep(2000);
  }
  throw new Error("Records did not become healthy in time");
}

/**
 * Create the service user, the workspace and the API key, headlessly (spike 2026-10-03: 8 s).
 * The user's password is the "instance admin credential" and is returned to the caller to keep out of the gateway.
 * @param {{ runner: Runner, url: string, origin: string, email: string, password: string, displayName: string }} o
 */
export async function bootstrap(o) {
  const gq = async (/** @type {string} */ query, /** @type {string | undefined} */ token) => {
    const res = await o.runner.fetch(`${o.url}/metadata`, { method: "POST", headers: { "content-type": "application/json", origin: o.origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query }) });
    const j = /** @type {any} */ (await res.json());
    if (j.errors) throw new Error(`Records bootstrap failed: ${String(j.errors[0]?.message).slice(0, 200)}`);
    return j.data;
  };
  const q = (/** @type {string} */ s) => JSON.stringify(s);
  let signUp;
  try { signUp = (await gq(`mutation Boot_signUp { signUp(email: ${q(o.email)}, password: ${q(o.password)}) { tokens { accessOrWorkspaceAgnosticToken { token } } } }`)).signUp; }
  catch { signUp = (await gq(`mutation Boot_signIn { signIn(email: ${q(o.email)}, password: ${q(o.password)}) { tokens { accessOrWorkspaceAgnosticToken { token } } } }`)).signIn; }
  const agnostic = signUp.tokens.accessOrWorkspaceAgnosticToken.token;
  const nw = (await gq(`mutation Boot_workspace { signUpInNewWorkspace(input: { displayName: ${q(o.displayName)} }) { loginToken { token } workspace { id } } }`, agnostic)).signUpInNewWorkspace;
  const tk = await gq(`mutation Boot_login { getAuthTokensFromLoginToken(loginToken: ${q(nw.loginToken.token)}, origin: ${q(o.origin)}) { tokens { accessOrWorkspaceAgnosticToken { token } } } }`);
  const access = tk.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
  await gq("mutation Boot_activate { activateWorkspace(data: {}) { id } }", access);
  const roles = await gq("query Boot_roles { getRoles { id label } }", access);
  const role = roles.getRoles.find((/** @type {any} */ r) => r.label === "Admin") ?? roles.getRoles[0];
  const exp = new Date(Date.now() + 365 * 864e5).toISOString();
  const ak = await gq(`mutation Boot_key { createApiKey(input: { name: "vyre-gateway", expiresAt: ${q(exp)}, roleId: ${q(role.id)} }) { id } }`, access);
  const tok = await gq(`mutation Boot_token { generateApiKeyToken(apiKeyId: ${q(ak.createApiKey.id)}, expiresAt: ${q(exp)}) { token } }`, access);
  // Password sign-in stays on: key rotation signs in as this user (an API key cannot make a key or change the workspace, measured on a real Twenty), and Twenty is reachable only from the Space's own network.
  return { workspaceId: nw.workspace.id, apiKey: tok.generateApiKeyToken.token, apiKeyId: ak.createApiKey.id, expiresAt: exp };
}

/**
 * Upgrade a Space's Twenty: back up the database, change the image, wait until healthy, then run
 * `verify` (the conformance and isolation tests) before the store reopens. A failure restores the
 * dump and the old image together and re-runs verify.
 * @param {ProvisionOptions & { toImage: string, verify: () => Promise<void> }} o `toImage` is a full pinned reference (tag and digest)
 * @returns {Promise<{ ok: boolean, from: string, to: string, backup: string, rolledBack: boolean, seconds: number }>}
 */
export async function upgradeSpace(o) {
  if (!isPinnedRef(o.toImage)) throw new Error(`An upgrade names a full image reference with a digest (name:tag@sha256:...), not ${String(o.toImage).slice(0, 80)}`);
  const n = names(o.space); const runner = o.runner ?? realRunner(); const dir = spaceDir(o.home, o.space);
  const envFile = path.join(dir, ".env");
  const env = fs.readFileSync(envFile, "utf8");
  const from = /^TWENTY_IMAGE_REF=(.*)$/m.exec(env)?.[1] ?? "";
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, "backups", `pre-${tagOfRef(o.toImage)}-${stamp}.dump`);
  const dump = await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "exec", "-T", "db", "pg_dump", "-U", "postgres", "--clean", "--if-exists", "--no-owner", "default"], { cwd: dir });
  writePrivate(backup, dump.stdout);
  const setImage = (/** @type {string} */ t) => writePrivate(envFile, /^TWENTY_IMAGE_REF=/m.test(env) ? env.replace(/^TWENTY_IMAGE_REF=.*$/m, `TWENTY_IMAGE_REF=${t}`) : `${env}${env.endsWith("\n") ? "" : "\n"}TWENTY_IMAGE_REF=${t}\n`);
  setImage(o.toImage);
  try {
    await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait"], { cwd: dir });
    await o.verify();
    return { ok: true, from, to: o.toImage, backup, rolledBack: false, seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    setImage(from);
    await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "stop", "server", "worker"], { cwd: dir });
    await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "postgres", "-c", "DROP DATABASE default WITH (FORCE)", "-c", "CREATE DATABASE default"], { cwd: dir });
    await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "exec", "-T", "db", "psql", "-U", "postgres", "-d", "default", "-v", "ON_ERROR_STOP=1"], { cwd: dir, input: dump.stdout });
    await runner.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait"], { cwd: dir });
    await o.verify();
    return { ok: false, from, to: o.toImage, backup, rolledBack: true, seconds: Math.round((Date.now() - t0) / 1000) };
  }
}

const compose = (/** @type {string[]} */ ...a) => ["compose", "-f", "compose.yml", "--env-file", ".env", ...a];
const sha = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * A backup of one Space's Twenty and nothing else: the database (a plain SQL dump), the file volume, and the Space's folder
 * (compose file, secrets, the store's state). One folder, a manifest with a checksum of each part, mode 0600. It holds the
 * Space's secrets in the clear, so a caller encrypts it before it leaves the machine (the continuity bundle's age step).
 * The Space keeps running: pg_dump is a consistent snapshot, and the file volume is read-only.
 * @param {{ home: string, space: string, runner?: Runner, outDir?: string, log?: (line: string) => void }} o
 * @returns {Promise<{ dir: string, manifest: any, seconds: number }>}
 */
export async function backupSpace(o) {
  const n = names(o.space); const runner = o.runner ?? realRunner(); const dir = spaceDir(o.home, o.space); const log = o.log ?? (() => {});
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(o.outDir ?? path.join(dir, "backups"), `space-${o.space}-${stamp}`);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const dump = await runner.exec("docker", compose("exec", "-T", "db", "pg_dump", "-U", "postgres", "--clean", "--if-exists", "--no-owner", "default"), { cwd: dir });
  writePrivate(path.join(out, "db.sql"), dump.stdout);
  log(`database dumped (${dump.stdout.length} bytes)`);
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : "0:0";
  await runner.exec("docker", ["run", "--rm", "-v", `${n.volumes.files}:/data:ro`, "-v", `${path.resolve(out)}:/out`, "alpine", "sh", "-c", `tar -C /data -czf /out/files.tgz . && chown ${uid} /out/files.tgz`], {});
  fs.chmodSync(path.join(out, "files.tgz"), 0o600);
  // the Space's own folder, without the backups folder and the empty front end
  const keep = ["compose.yml", ".env", "webhook.secret", "service.key", "workspace.id", "admin.secret", "memory.json"].filter((f) => fs.existsSync(path.join(dir, f)));
  /** @type {Record<string, string>} */ const folder = {};
  for (const f of keep) folder[f] = fs.readFileSync(path.join(dir, f), "utf8");
  const stateDir = path.join(dir, "state");
  /** @type {Record<string, string>} */ const state = {};
  if (fs.existsSync(stateDir)) for (const f of fs.readdirSync(stateDir)) { const p = path.join(stateDir, f); if (fs.statSync(p).isFile()) state[f] = fs.readFileSync(p, "utf8"); }
  writePrivate(path.join(out, "space.json"), JSON.stringify({ folder, state }));
  const image = /^TWENTY_IMAGE_REF=(.*)$/m.exec(folder[".env"] ?? "")?.[1] ?? TWENTY_TESTED_REF;
  const manifest = { format: 1, space: o.space, image, created_at: new Date().toISOString(), parts: Object.fromEntries(["db.sql", "files.tgz", "space.json"].map((f) => [f, { bytes: fs.statSync(path.join(out, f)).size, sha256: sha(fs.readFileSync(path.join(out, f))) }])) };
  writePrivate(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir: out, manifest, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

/**
 * Bring a backup up as a Space on this machine: the same box after a loss, or another one (a move). `space` may be a new name:
 * the compose file is rewritten for it and the secrets are kept, so the service key still works (it is signed with the Space's
 * own APP_SECRET). Checks every part's checksum before it touches anything. Refuses a Space that is already provisioned here.
 * @param {{ home: string, space: string, from: string, runner?: Runner, reach?: "alias" | "ip" | "loopback", log?: (line: string) => void }} o
 * @returns {Promise<Provisioned & { seconds: number }>}
 */
export async function restoreSpace(o) {
  const n = names(o.space); const runner = o.runner ?? realRunner(); const dir = spaceDir(o.home, o.space); const log = o.log ?? (() => {});
  const t0 = Date.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(o.from, "manifest.json"), "utf8"));
  for (const [f, m] of Object.entries(/** @type {Record<string, any>} */ (manifest.parts))) {
    if (sha(fs.readFileSync(path.join(o.from, f))) !== m.sha256) throw new Error(`The backup is damaged: ${f} does not match its checksum`);
  }
  if (fs.existsSync(path.join(dir, "service.key"))) throw new Error(`Space ${o.space} is already provisioned here; remove it first`);
  const sp = JSON.parse(fs.readFileSync(path.join(o.from, "space.json"), "utf8"));
  fs.mkdirSync(path.join(dir, "empty-front"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true, mode: 0o700 });
  for (const [f, text] of Object.entries(/** @type {Record<string, string>} */ (sp.folder))) if (f !== "compose.yml") writePrivate(path.join(dir, f), text);
  for (const [f, text] of Object.entries(/** @type {Record<string, string>} */ (sp.state))) writePrivate(path.join(dir, "state", f), text);
  const memory = fs.existsSync(path.join(dir, "memory.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "memory.json"), "utf8")) : undefined;
  writePrivate(path.join(dir, "compose.yml"), composeFile({ space: o.space, image: manifest.image ?? (manifest.tag === TWENTY_TESTED_TAG ? TWENTY_TESTED_REF : undefined), memory }));
  log("starting the database");
  await runner.exec("docker", compose("up", "-d", "--wait", "db"), { cwd: dir });
  await runner.exec("docker", compose("exec", "-T", "db", "psql", "-U", "postgres", "-d", "default", "-v", "ON_ERROR_STOP=1"), { cwd: dir, input: fs.readFileSync(path.join(o.from, "db.sql"), "utf8") });
  log("database restored");
  const filesTgz = path.join(o.from, "files.tgz");
  if (fs.statSync(filesTgz).size > 0) {
    await runner.exec("docker", ["run", "--rm", "-v", `${n.volumes.files}:/data`, "-v", `${path.resolve(o.from)}:/in:ro`, "alpine", "tar", "-C", "/data", "-xzf", "/in/files.tgz"], {});
  }
  await runner.exec("docker", compose("up", "-d", "--wait"), { cwd: dir });
  const origin = `http://${n.serverAlias}:3000`;
  const url = await reachUrl({ home: o.home, space: o.space, reach: o.reach }, runner, n, origin);
  await waitHealthy(runner, url);
  const base = { space: o.space, dir, origin, keyFile: path.join(dir, "service.key"), network: n.network, serverAlias: n.serverAlias, gatewayAlias: n.gatewayAlias, webhookSecretFile: path.join(dir, "webhook.secret"), image: manifest.image ?? TWENTY_TESTED_REF };
  return { ...base, url, workspaceId: fs.readFileSync(path.join(dir, "workspace.id"), "utf8").trim(), seconds: Math.round((Date.now() - t0) / 100) / 10 };
}


// ---- the Space's API key: one year of life, rotated well before it ends --------------------------------------------------------------------------------
export const KEY_LIFE_DAYS = 365;
/** Rotate when fewer than this many days are left; warn loudly when fewer than WARN_DAYS are left and rotation has not worked. */
export const KEY_ROTATE_WITHIN_DAYS = 90;
export const KEY_WARN_DAYS = 30;

/** The expiry of a JWT-shaped key, in ms, or null. @param {string} token */
export function keyExpiry(token) {
  try { const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp; return typeof exp === "number" ? exp * 1000 : null; } catch { return null; }
}

/**
 * Where a Space's key stands. `ok` is false when it has expired or cannot be read, `rotate` when it is inside the rotation window.
 * @param {{ home: string, space: string, now?: () => number }} o
 */
export function keyHealth(o) {
  const dir = spaceDir(o.home, o.space); const now = (o.now ?? Date.now)();
  let token = ""; try { token = fs.readFileSync(path.join(dir, "service.key"), "utf8").trim(); } catch { return { ok: false, rotate: true, daysLeft: null, expiresAt: null, why: "the Space's key file cannot be read" }; }
  const exp = keyExpiry(token);
  if (exp === null) return { ok: true, rotate: false, daysLeft: null, expiresAt: null, why: "the key carries no expiry" };
  const daysLeft = Math.floor((exp - now) / 864e5);
  return { ok: exp > now, rotate: daysLeft < KEY_ROTATE_WITHIN_DAYS, daysLeft, expiresAt: new Date(exp).toISOString(), ...(exp <= now ? { why: "the Space's key has expired" } : {}) };
}

/**
 * Make a new key for the Space, check it works, write it over the old one (0600, in one rename so a reader never sees half a key), then revoke the old.
 * Uses the instance admin credential kept for provisioning (admin.secret), never the running key. The store reads the key file on every call, so nothing restarts.
 * @param {{ home: string, space: string, runner?: Runner, now?: () => number, force?: boolean, url?: string, reach?: "alias" | "ip" | "loopback", log?: (line: string) => void }} o
 * @returns {Promise<{ rotated: boolean, expiresAt?: string, why?: string }>}
 */
export async function rotateApiKey(o) {
  const n = names(o.space); const runner = o.runner ?? realRunner(); const dir = spaceDir(o.home, o.space); const log = o.log ?? (() => {}); const now = (o.now ?? Date.now)();
  const h = keyHealth({ home: o.home, space: o.space, now: () => now });
  if (!o.force && !h.rotate) return { rotated: false, why: `${h.daysLeft} days left` };
  const admin = JSON.parse(fs.readFileSync(path.join(dir, "admin.secret"), "utf8"));
  const origin = `http://${n.serverAlias}:3000`;
  const url = o.url ?? await reachUrl({ home: o.home, space: o.space, reach: o.reach ?? "ip" }, runner, n, origin);
  const gq = async (/** @type {string} */ query, /** @type {string | undefined} */ token, /** @type {string | undefined} */ useKey) => {
    const res = await runner.fetch(`${url}/metadata`, { method: "POST", headers: { "content-type": "application/json", origin, ...(token || useKey ? { authorization: `Bearer ${token ?? useKey}` } : {}) }, body: JSON.stringify({ query }) });
    const j = /** @type {any} */ (await res.json());
    if (j.errors) throw new Error(`Records key rotation failed: ${String(j.errors[0]?.message).slice(0, 200)}`);
    return j.data;
  };
  const q = (/** @type {string} */ x) => JSON.stringify(x);
  const lt = await gq(`mutation Rot_loginToken { getLoginTokenFromCredentials(email: ${q(admin.email)}, password: ${q(admin.password)}, origin: ${q(origin)}) { loginToken { token } } }`, undefined, undefined);
  const tk = await gq(`mutation Rot_login { getAuthTokensFromLoginToken(loginToken: ${q(lt.getLoginTokenFromCredentials.loginToken.token)}, origin: ${q(origin)}) { tokens { accessOrWorkspaceAgnosticToken { token } } } }`, undefined, undefined);
  const access = tk.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
  const roles = await gq("query Rot_roles { getRoles { id label } }", access, undefined);
  const role = roles.getRoles.find((/** @type {any} */ r) => r.label === KEY_ROLE) ?? roles.getRoles.find((/** @type {any} */ r) => r.label === "Admin") ?? roles.getRoles[0];
  const exp = new Date(now + KEY_LIFE_DAYS * 864e5).toISOString();
  const ak = await gq(`mutation Rot_key { createApiKey(input: { name: "vyre-gateway", expiresAt: ${q(exp)}, roleId: ${q(role.id)} }) { id } }`, access, undefined);
  const tok = await gq(`mutation Rot_token { generateApiKeyToken(apiKeyId: ${q(ak.createApiKey.id)}, expiresAt: ${q(exp)}) { token } }`, access, undefined);
  const fresh = tok.generateApiKeyToken.token;
  await gq("query Rot_check { objects(paging: { first: 1 }) { edges { node { id } } } }", undefined, fresh); // the new key must work before it replaces the old
  const keyFile = path.join(dir, "service.key"); const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "key.json"), "utf8")); } catch { return {}; } })();
  fs.writeFileSync(`${keyFile}.new`, fresh, { mode: 0o600 }); fs.renameSync(`${keyFile}.new`, keyFile); fs.chmodSync(keyFile, 0o600);
  writePrivate(path.join(dir, "key.json"), JSON.stringify({ apiKeyId: ak.createApiKey.id, expiresAt: exp, rotatedAt: new Date(now).toISOString(), previous: prev.apiKeyId ?? null }));
  if (prev.apiKeyId) { try { await gq(`mutation Rot_revoke { revokeApiKey(input: { id: ${q(prev.apiKeyId)} }) { id } }`, access, undefined); } catch (e) { log(`the old key could not be revoked (it will expire on its own): ${/** @type {Error} */ (e).message}`); } }
  log(`key rotated; new expiry ${exp}`);
  return { rotated: true, expiresAt: exp };
}

/** The role the gateway's key takes. Admin until the narrowest role that works has been researched (team/archive/work-journals/records.md). */
export const KEY_ROLE = "Admin";
