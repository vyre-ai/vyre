// @ts-check
// lib/spaces/home-unit.js: the files of ONE space's home, as plain data. A space is one unit (its own kernel,
// Twenty, Postgres, Redis, log, files and keys), so a move or a backup knows the whole thing from the manifest.
// Nothing is shared between two spaces on the same host: every volume, network, container name, host port and
// secret is per space. Pure: randomness is injected, nothing is written here. The caller writes `files`.
// Source: team/0.3/DESIGN-spaces-first.md section 2, team/0.2.5/DECISION-space-shape.md item 7.

import { createHash } from "node:crypto";

export const SPACE_ID_RE = /^spc_[a-z0-9]{6,32}$/;

/** Pinned defaults. TWENTY_IMAGE in the env file or the shell overrides the Twenty one. Twenty is pinned by tag AND digest to the release stores/twenty's live suite passes against (v2.44.0, stores/twenty/provision.js TWENTY_TESTED_TAG; the digest is that tag's image on testbox, 5 Oct 2026). */
export const IMAGES = Object.freeze({
  vyre: "${VYRE_IMAGE:-ghcr.io/vyre-ai/vyre:latest}",
  twenty: "${TWENTY_IMAGE:-twentycrm/twenty:v2.44.0@sha256:01fb6d2c00397976fd7613dbeb9703b514b52fb6270339b7a326a2a975d15b26}",
  postgres: "postgres:16.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c",
  redis: "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
});

const DEFAULT_LIMITS = Object.freeze({
  vyred: { mem: "1g", cpus: "1.0", pids: 512 },
  "twenty-server": { mem: "1536m", cpus: "1.0", pids: 512 },
  "twenty-worker": { mem: "1g", cpus: "0.75", pids: 256 },
  db: { mem: "1g", cpus: "1.0", pids: 256 },
  redis: { mem: "256m", cpus: "0.25", pids: 64 },
});

/** The volumes of a unit, by short name. `keys` holds the node keys; the log and files are the space's own. */
export const VOLUME_ROLES = Object.freeze(["db", "redis", "twenty-files", "log", "files", "keys"]);

/** @param {string} spaceId */
export function hostPortFor(spaceId) {
  const h = createHash("sha256").update(spaceId).digest();
  return 20000 + (h.readUInt16BE(0) % 4000) * 2; // even ports: base for vyred, base+1 reserved
}

/**
 * @typedef {{ random: (n: number) => Uint8Array, hostPort?: number,
 *   twentyImage?: string, limits?: Record<string, { mem: string, cpus: string, pids: number }> }} UnitOptions
 */

/**
 * @param {{ id: string, name?: string }} space
 * @param {UnitOptions} options
 */
export function homeUnit(space, options) {
  const id = space?.id;
  if (typeof id !== "string" || !SPACE_ID_RE.test(id)) throw new Error("A space id looks like spc_ followed by 6 to 32 lowercase letters or digits.");
  if (typeof options?.random !== "function") throw new Error("homeUnit needs a random source.");
  const project = `vyre-${id}`;
  const vol = (/** @type {string} */ role) => `${project}-${role}`;
  const net = (/** @type {string} */ role) => `${project}-${role}`;
  const hostPort = options.hostPort ?? hostPortFor(id);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const secret = () => Buffer.from(options.random(24)).toString("hex");

  const env = {
    PG_PASSWORD: secret(),
    REDIS_PASSWORD: secret(),
    TWENTY_APP_SECRET: secret(),
    VYRE_UNIT_TOKEN: secret(),
  };
  const volumeRoles = VOLUME_ROLES;
  const lim = (/** @type {string} */ s) => ({ mem_limit: limits[s].mem, cpus: limits[s].cpus, pids_limit: limits[s].pids });
  const hardening = { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], restart: "unless-stopped" };
  const internal = [net("internal")];

  /** @type {Record<string, any>} */
  const services = {
    vyred: {
      image: IMAGES.vyre, container_name: `${project}-vyred`, ...hardening, ...lim("vyred"),
      user: "1000:1000",
      environment: { VYRE_SPACE_ID: id, VYRE_UNIT_TOKEN: "${VYRE_UNIT_TOKEN}", VYRE_TWENTY_URL: "http://twenty-server:3000", VYRE_LOG_DIR: "/var/log/vyre", VYRE_FILES_DIR: "/files", VYRE_VAULT_DIR: "/keys" },
      ports: [`127.0.0.1:${hostPort}:7443`],
      volumes: [`${vol("log")}:/var/log/vyre`, `${vol("files")}:/files`, `${vol("keys")}:/keys`],
      tmpfs: ["/tmp"],
      networks: [net("edge"), net("internal")],
      depends_on: ["twenty-server"],
    },
    "twenty-server": {
      image: IMAGES.twenty, container_name: `${project}-twenty-server`, ...hardening, ...lim("twenty-server"),
      environment: {
        NODE_PORT: "3000", PG_DATABASE_URL: "postgres://twenty:${PG_PASSWORD}@db:5432/twenty",
        REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379", APP_SECRET: "${TWENTY_APP_SECRET}", STORAGE_TYPE: "local",
      },
      volumes: [`${vol("twenty-files")}:/app/packages/twenty-server/.local-storage`],
      tmpfs: ["/tmp"],
      networks: internal, depends_on: ["db", "redis"],
    },
    "twenty-worker": {
      image: IMAGES.twenty, container_name: `${project}-twenty-worker`, ...hardening, ...lim("twenty-worker"),
      command: ["yarn", "worker:prod"],
      environment: {
        PG_DATABASE_URL: "postgres://twenty:${PG_PASSWORD}@db:5432/twenty", REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379",
        APP_SECRET: "${TWENTY_APP_SECRET}", DISABLE_DB_MIGRATIONS: "true", STORAGE_TYPE: "local",
      },
      volumes: [`${vol("twenty-files")}:/app/packages/twenty-server/.local-storage`],
      tmpfs: ["/tmp"],
      networks: internal, depends_on: ["twenty-server"],
    },
    db: {
      image: IMAGES.postgres, container_name: `${project}-db`, ...hardening, ...lim("db"),
      environment: { POSTGRES_USER: "twenty", POSTGRES_DB: "twenty", POSTGRES_PASSWORD: "${PG_PASSWORD}" },
      volumes: [`${vol("db")}:/var/lib/postgresql/data`],
      tmpfs: ["/tmp", "/var/run/postgresql"],
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U twenty"], interval: "10s", timeout: "5s", retries: 10 },
      networks: internal,
    },
    redis: {
      image: IMAGES.redis, container_name: `${project}-redis`, ...hardening, ...lim("redis"),
      command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}", "--appendonly", "yes"],
      volumes: [`${vol("redis")}:/data`],
      tmpfs: ["/tmp"],
      networks: internal,
    },
  };
  const volumes = Object.fromEntries(volumeRoles.map(r => [vol(r), { name: vol(r) }]));
  const networks = { [net("edge")]: { name: net("edge") }, [net("internal")]: { name: net("internal"), internal: true } };
  const manifest = {
    spaceId: id,
    project,
    volumes: volumeRoles.map(vol),
    keysVolume: vol("keys"),
    keysDir: "/keys",
    networks: Object.keys(networks),
    hostPorts: [hostPort],
    services: Object.keys(services),
  };
  const compose = { name: project, services, volumes, networks, "x-vyre": { manifest } };

  const twentyImage = options.twentyImage;
  // an image named in the env file is held to the same rule as the defaults: a full reference with a digest, or the unit is not made
  if (twentyImage !== undefined && !PINNED.test(String(twentyImage))) throw new Error(`The Twenty image must be a full reference with a digest (name:tag@sha256:...), not ${String(twentyImage).slice(0, 80)}`);
  const envText = Object.entries(twentyImage ? { ...env, TWENTY_IMAGE: twentyImage } : env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  // JSON is valid YAML, so `docker compose` reads this file as it is.
  const files = [
    { path: "compose.yml", mode: 0o644, content: JSON.stringify(compose, null, 2) + "\n" },
    { path: ".env", mode: 0o600, content: envText },
  ];
  return { project, compose, env, envText, files, manifest };
}

/** A full image reference: name, tag and sha256 digest. */
export const PINNED = /^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}$/;
/** The image a compose `image:` value stands for: the default of `${VAR:-default}`, else the value itself. @param {unknown} v */
const imageOf = v => { const m = /^\$\{[A-Z_]+:-(.*)\}$/.exec(String(v ?? "")); return m ? m[1] : String(v ?? ""); };

/** @param {any} v @returns {string[]} */
const asList = v => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.keys(v) : []);

/**
 * The invariants of a unit. Returns plain-words problems; empty means sound.
 * @param {any} compose
 * @param {{ envText?: string }} [o] the unit's env file: an image it names (TWENTY_IMAGE) must carry a digest too
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyUnit(compose, o = {}) {
  /** @type {string[]} */ const p = [];
  const project = compose?.name;
  if (typeof project !== "string" || !project.startsWith("vyre-spc_")) return { ok: false, problems: ["The unit has no per-space project name."] };
  const prefix = project + "-";
  const services = compose.services ?? {};
  const volumes = compose.volumes ?? {};
  const networks = compose.networks ?? {};
  for (const [n, v] of Object.entries(volumes)) if (!n.startsWith(prefix) || /** @type {any} */ (v)?.name !== n) p.push(`Volume ${n} is not named for this space.`);
  for (const [n, v] of Object.entries(networks)) {
    if (!n.startsWith(prefix) || /** @type {any} */ (v)?.name !== n) p.push(`Network ${n} is not named for this space.`);
    if (/** @type {any} */ (v)?.external) p.push(`Network ${n} is external, so it could be shared.`);
  }
  for (const [n, v] of Object.entries(volumes)) if (/** @type {any} */ (v)?.external) p.push(`Volume ${n} is external, so it could be shared.`);
  const manifest = compose["x-vyre"]?.manifest;
  if (!manifest || JSON.stringify([...manifest.volumes].sort()) !== JSON.stringify(Object.keys(volumes).sort())) p.push("The manifest does not list exactly the unit's volumes.");
  if (manifest && !Object.keys(volumes).includes(manifest.keysVolume)) p.push("The manifest does not name the keys volume.");
  const used = new Set();
  for (const [name, s] of Object.entries(services)) {
    const svc = /** @type {any} */ (s);
    if (svc.privileged) p.push(`${name} runs privileged.`);
    if (svc.network_mode) p.push(`${name} sets a network mode (${svc.network_mode}).`);
    if (svc.pid || svc.ipc || svc.userns_mode) p.push(`${name} shares a host namespace.`);
    if (asList(svc.cap_add).length) p.push(`${name} adds capabilities.`);
    if (asList(svc.devices).length) p.push(`${name} mounts a device.`);
    if (svc.container_name && !String(svc.container_name).startsWith(prefix)) p.push(`${name} has a container name that is not per space.`);
    if (svc.read_only !== true) p.push(`${name} does not have a read-only root.`);
    if (!svc.mem_limit || !svc.cpus || !svc.pids_limit) p.push(`${name} has no resource limits.`);
    for (const v of asList(svc.volumes)) {
      const src = String(v).split(":")[0];
      if (/docker\.sock/.test(String(v))) p.push(`${name} mounts the docker socket.`);
      else if (src.startsWith("/") || src.startsWith(".") || src.startsWith("~")) p.push(`${name} mounts a host path (${src}).`);
      else if (!Object.keys(volumes).includes(src)) p.push(`${name} uses a volume (${src}) that is not part of this unit.`);
      else used.add(src);
    }
    for (const n of asList(svc.networks)) if (!Object.keys(networks).includes(n)) p.push(`${name} joins a network (${n}) that is not part of this unit.`);
    for (const port of asList(svc.ports)) {
      const s2 = typeof port === "string" ? port : String(port?.published ?? "");
      if (!/^127\.0\.0\.1:\d+:\d+(\/\w+)?$/.test(s2)) p.push(`${name} publishes a port beyond loopback (${s2}).`);
    }
    for (const [k, v] of Object.entries(svc.environment ?? {})) {
      if (/(PASSWORD|SECRET|TOKEN|KEY)/i.test(k) && !String(v).startsWith("${")) p.push(`${name} has the secret ${k} written into the file.`);
    }
    if (/:latest\b/.test(String(svc.image ?? "")) && name !== "vyred") p.push(`${name} uses an unpinned image.`);
    else if (name !== "vyred" && !PINNED.test(imageOf(svc.image))) p.push(`${name} uses an image with no digest.`);
  }
  for (const v of Object.keys(volumes)) if (!used.has(v)) p.push(`Volume ${v} is not used by any service.`);
  for (const line of String(o.envText ?? "").split("\n")) { const m = /^(TWENTY_IMAGE|POSTGRES_IMAGE|REDIS_IMAGE|HEADSCALE_IMAGE)=(.*)$/.exec(line); if (m && !PINNED.test(m[2])) p.push(`The env file names ${m[1]} without a digest.`); }
  return { ok: p.length === 0, problems: p };
}

/**
 * Two units on one host must share nothing. Returns the shared things, by plain name.
 * @param {ReturnType<typeof homeUnit>} a @param {ReturnType<typeof homeUnit>} b
 */
export function sharedBetween(a, b) {
  const both = (/** @type {string[]} */ x, /** @type {string[]} */ y) => x.filter(v => y.includes(v));
  const containers = (/** @type {any} */ u) => Object.values(u.compose.services).map((/** @type {any} */ s) => s.container_name);
  return {
    project: a.project === b.project ? [a.project] : [],
    volumes: both(a.manifest.volumes, b.manifest.volumes),
    networks: both(a.manifest.networks, b.manifest.networks),
    ports: both(a.manifest.hostPorts.map(String), b.manifest.hostPorts.map(String)),
    containers: both(containers(a), containers(b)),
    secrets: both(Object.values(a.env), Object.values(b.env)),
  };
}
