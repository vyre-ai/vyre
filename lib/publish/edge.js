// @ts-check
// lib/publish/edge.js: generators for the Publish edge, as plain data plus text. Nothing here runs Docker.
//
// Publish is its own internet-facing container set, isolated from the space's data and control plane:
//   caddy      the only public service (80, 443), automatic HTTPS for verified domains and generated hosts only
//   buildkit   rootless, no published ports, reachable only from the build network
//   w-<id>     one service per workload, each on its own internal network
// No Docker socket, no host network, no privileged, no bind mounts, no volume shared with the space, no space env,
// cap_drop ALL, no-new-privileges, read-only root, resource limits. `assertIsolated` checks all of it on any compose object.

import { fail, SPACE_RE, DEPLOYMENT_ID_RE, ENV_NAME_RE, SECRET_REF_RE, isSpaceEnvName, NAME_RE } from "./util.js";
import { normalizeHost } from "./hostname.js";
import { JOIN_CSP, JOIN_FILE } from "./join.js";

export const IMAGES = Object.freeze({
  // The Caddy the edge runs is a derived image (caddyDockerfile below), built once on the box from the official one: the official binary carries a file capability that cannot exec
  // under cap_drop ALL (EPERM), and its /data and /config are root-owned so a non-root Caddy cannot keep its certificates. Both were found running the real project.
  caddy: "vyre-publish-caddy:2.8",
  caddyBase: "caddy:2.8-alpine",
  buildkit: "moby/buildkit:v0.15.2-rootless",
});
/** Registries a build may reach; also the `needs.network` a build Flow declares. */
export const REGISTRIES = Object.freeze(["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"]);
export const STATIC_PORT = 8080;

/**
 * The Dockerfile for the edge's Caddy image (`docker build -t <IMAGES.caddy> -f caddy.Dockerfile .`): the official binary copied through a plain `cp` (which drops its file capability; a COPY of the original keeps it), so it starts under
 * cap_drop ALL, on a small base, with /data and /config owned by the non-root user the edge runs as, so a new named volume starts writable and keeps the certificates.
 * @param {string} [base] the official image to take the binary from
 */
export function caddyDockerfile(base = IMAGES.caddyBase) {
  if (!IMAGE_RE.test(base)) fail("bad_input", "bad image reference");
  return `FROM ${base} AS official\nRUN cp /usr/bin/caddy /caddy.plain && chmod 755 /caddy.plain\nFROM alpine:3.20\nCOPY --from=official /caddy.plain /usr/bin/caddy\nRUN mkdir -p /data/caddy /config/caddy /etc/caddy && chown -R 65532:65532 /data /config\nENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data\nUSER 65532:65532\n`;
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._\/-]{0,127}(@sha256:[0-9a-f]{64}|:[A-Za-z0-9._-]{1,64})$/;
const WORKLOAD_KEYS = new Set(["id", "name", "kind", "image", "port", "env", "secrets", "egress", "limits", "stage"]);
const FORBIDDEN_ASKS = ["volumes", "mounts", "bind", "binds", "privileged", "network_mode", "network", "networks", "cap_add", "devices", "pid", "ipc", "ports", "security_opt", "user", "sysctls", "docker_sock", "volumes_from", "extra_hosts", "dns", "env_file", "command", "entrypoint", "read_only", "cap_drop", "tmpfs", "configs", "build"];

const FORBIDDEN_TEXT = ["docker.sock", "/var/run", "/run/docker", "/srv/vyre", "/.vyre", "~/", "host.docker.internal", "/proc/", "/sys/", "/root"];
const FORBIDDEN_NETWORK_WORDS = /(wink|control|tailnet|tailscale|home|twenty|postgres|vyred|default|host|bridge)/;

const slugOf = (/** @type {string} */ id) => id.replace(/^dep_/, "");
export const serviceName = (/** @type {string} */ id) => `w-${slugOf(id)}`;
export const projectName = (/** @type {string} */ spaceId) => { if (!SPACE_RE.test(spaceId)) fail("bad_input", "bad space id"); return `vyre-publish-${spaceId}`; };

/** Host a preview is served at: `<id>.preview.<space name>`. @param {string} id @param {string} spaceName */
export function previewHost(id, spaceName) {
  if (!DEPLOYMENT_ID_RE.test(id)) fail("bad_input", "bad deployment id");
  normalizeHost(spaceName);
  return normalizeHost(`${slugOf(id)}.preview.${spaceName}`, { generated: true }).ascii;
}
/** Host a production site is served at before it has its own domain: `<name>.<space name>`. @param {string} name @param {string} spaceName */
export function defaultHost(name, spaceName) {
  if (!NAME_RE.test(name)) fail("bad_input", "bad site name");
  normalizeHost(spaceName);
  return normalizeHost(`${name}.${spaceName}`, { generated: true }).ascii;
}

/**
 * @typedef {{ id: string, name?: string, kind: "static" | "node", image?: string, port?: number, env?: Record<string, string>,
 *   secrets?: string[], egress?: boolean, limits?: { mem?: string, cpus?: number, pids?: number }, stage?: string }} Workload
 */

/** @param {any} w @returns {Workload} */
export function validateWorkload(w) {
  if (!w || typeof w !== "object") fail("bad_input", "a workload is required");
  for (const k of Object.keys(w)) {
    if (FORBIDDEN_ASKS.includes(k)) fail("isolation", `a published workload may not set ${k}; the edge decides how it runs`, { key: k });
    if (!WORKLOAD_KEYS.has(k)) fail("isolation", `unknown workload setting ${k}`, { key: k });
  }
  if (!DEPLOYMENT_ID_RE.test(w.id)) fail("bad_input", "bad workload id");
  // Strict types: every setting is the type it is documented as, or the whole spec is refused (a truthy string for `egress` once put a workload on the egress bridge, EG-1).
  const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (w.name !== undefined && (typeof w.name !== "string" || w.name.length > 100)) fail("bad_input", "name is text");
  if (w.egress !== undefined && w.egress !== false) fail("isolation", "outbound network access for a site is not offered yet");
  if (w.env !== undefined && !isObj(w.env)) fail("bad_input", "env is a map of plain values");
  if (w.secrets !== undefined && !(Array.isArray(w.secrets) && w.secrets.every((/** @type {any} */ x) => typeof x === "string"))) fail("bad_input", "secrets is a list of granted names");
  if (w.limits !== undefined && !(isObj(w.limits) && Object.keys(w.limits).every(k => ["mem", "cpus", "pids"].includes(k)) && (w.limits.mem === undefined || typeof w.limits.mem === "string") && (w.limits.cpus === undefined || typeof w.limits.cpus === "number") && (w.limits.pids === undefined || typeof w.limits.pids === "number"))) fail("bad_input", "limits are mem, cpus and pids");
  if (w.stage !== undefined && typeof w.stage !== "string") fail("bad_input", "stage is text");
  if (w.kind !== "static" && w.kind !== "node") fail("bad_input", "workload kind is static or node");
  if (w.kind === "node") {
    if (typeof w.image !== "string" || !IMAGE_RE.test(w.image) || /docker|socket/i.test(w.image)) fail("bad_input", "a node workload needs an image built by Publish (name@sha256:...)");
    if (!Number.isInteger(w.port) || w.port < 1024 || w.port > 65535) fail("bad_input", "port must be 1024 to 65535");
  } else {
    if (w.image != null || w.port != null) fail("bad_input", "a static workload has no image or port of its own");
    // A static site is files and nothing else: it takes no environment and is granted no secrets (a granted secret is a file under /run/secrets, which a link in the site could point to).
    if (Object.keys(w.env || {}).length || (w.secrets || []).length) fail("isolation", "a static site takes no environment and no secrets");
  }
  for (const [k, v] of Object.entries(w.env || {})) {
    if (!ENV_NAME_RE.test(k)) fail("bad_input", `env name ${k} is not valid`);
    if (isSpaceEnvName(k)) fail("isolation", `env ${k} looks like a space secret or setting and is never passed`, { key: k });
    if (typeof v !== "string" || v.length > 500 || /[\u0000-\u001f\u007f]/.test(v) || SECRET_REF_RE.test(v)) fail("isolation", `env ${k} must be a plain value; secrets go through a grant`, { key: k });
  }
  for (const n of w.secrets || []) if (!ENV_NAME_RE.test(n) || isSpaceEnvName(n)) fail("isolation", `secret ${n} is not a valid granted name`, { key: n });
  if (w.stage != null && !["Preview", "Approved", "Production"].includes(w.stage)) fail("bad_input", "bad stage");
  return w;
}

const hardened = (/** @type {{ mem: string, cpus: number, pids: number }} */ lim) => ({
  restart: "unless-stopped",
  read_only: true,
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  mem_limit: lim.mem,
  cpus: lim.cpus,
  pids_limit: lim.pids,
  init: true,
  logging: { driver: "local", options: { "max-size": "10m", "max-file": "3" } },
});

const clampLimits = (/** @type {any} */ l = {}) => {
  const memOk = typeof l.mem === "string" && /^[0-9]{2,4}m$/.test(l.mem) && parseInt(l.mem, 10) <= 2048 && parseInt(l.mem, 10) >= 32;
  return {
    mem: memOk ? l.mem : "256m",
    cpus: Number.isFinite(l.cpus) && l.cpus > 0 && l.cpus <= 2 ? l.cpus : 0.5,
    pids: Number.isInteger(l.pids) && l.pids >= 16 && l.pids <= 512 ? l.pids : 128,
  };
};

/**
 * The compose project for a space's Publish edge.
 * @param {{ id: string, name: string }} space
 * @param {Workload[]} workloads
 * @param {{ images?: { caddy?: string, buildkit?: string }, tunnel?: boolean }} [opts] `tunnel`: the box has no public port; Caddy's 443 is published on the loopback only
 *   (TUNNEL_PORT) and the tunnel end (lib/publish/tunnel.js) carries the relay's streams to it. TCP only: HTTP/3 does not go through the tunnel.
 */
export function edgeCompose(space, workloads, opts = {}) {
  if (!space || typeof space !== "object") fail("bad_input", "a space is required");
  const project = projectName(space.id);
  normalizeHost(space.name);
  const images = { ...IMAGES, ...(opts.images || {}) };
  for (const i of Object.values(images)) if (!IMAGE_RE.test(i)) fail("bad_input", "bad image reference");
  const seen = new Set();
  /** @type {Record<string, any>} */ const services = {};
  /** @type {Record<string, any>} */ const networks = {
    edge: { driver: "bridge" },
    build: { driver: "bridge", internal: true, attachable: true },
    build_egress: { driver: "bridge", labels: { "vyre.publish.egress-allow": REGISTRIES.join(",") } },
    egress: { driver: "bridge" },
  };
  /** @type {Record<string, any>} */ const volumes = { "caddy-data": {}, "caddy-config": {}, "buildkit-state": {} };
  /** @type {Record<string, any>} */ const secrets = {};
  const caddyNets = ["edge"];
  let usesEgress = false;

  for (const raw of workloads) {
    const w = validateWorkload(raw);
    if (seen.has(w.id)) fail("duplicate", "a workload is listed twice");
    seen.add(w.id);
    const slug = slugOf(w.id), svc = serviceName(w.id), net = `wl-${slug}`;
    networks[net] = { driver: "bridge", internal: true };
    caddyNets.push(net);
    const svcNets = [net];
    if (w.egress) { svcNets.push("egress"); usesEgress = true; }
    const lim = clampLimits(w.limits);
    /** @type {Record<string, string>} */ const environment = { ...(w.env || {}) };
    /** @type {any[]} */ const svcSecrets = [];
    for (const n of w.secrets || []) {
      const key = `${slug}_${n}`;
      secrets[key] = { file: `./secrets/${w.id}/${n}` };
      svcSecrets.push({ source: key, target: n });
      environment[`${n}_FILE`] = `/run/secrets/${n}`;
    }
    const base = {
      ...hardened(lim),
      user: "65532:65532",
      tmpfs: ["/tmp:size=64m,noexec,nosuid,nodev"],
      networks: svcNets,
      labels: { "run.vyre.publish": "1", "vyre.publish.deployment": w.id },
      ...(Object.keys(environment).length ? { environment } : {}),
      ...(svcSecrets.length ? { secrets: svcSecrets } : {}),
    };
    if (w.kind === "static") {
      volumes[`site-${slug}`] = {};
      services[svc] = { ...base, image: images.caddy, command: ["caddy", "file-server", "--root", "/srv/site", "--listen", `:${STATIC_PORT}`], volumes: [`site-${slug}:/srv/site:ro`] };
    } else {
      services[svc] = { ...base, image: w.image };
    }
  }

  services.caddy = {
    ...hardened({ mem: "256m", cpus: 0.5, pids: 256 }),
    image: images.caddy,
    user: "65532:65532",
    ports: opts.tunnel === true ? [...CADDY_PORTS_TUNNEL] : [...CADDY_PORTS],
    // Binding 80 and 443 without any added capability.
    sysctls: { "net.ipv4.ip_unprivileged_port_start": 0 },
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    configs: [{ source: "caddyfile", target: "/etc/caddy/Caddyfile" }, { source: "joinpage", target: JOIN_FILE }],
    volumes: ["caddy-data:/data", "caddy-config:/config"],
    tmpfs: ["/tmp:size=64m,noexec,nosuid,nodev"],
    networks: caddyNets,
    labels: { "run.vyre.publish": "1", "vyre.publish.role": "edge" },
  };
  services.buildkit = {
    ...hardened({ mem: "2048m", cpus: 2, pids: 512 }),
    image: images.buildkit,
    user: "1000:1000",
    // Rootless needs a user-namespace seccomp profile shipped beside the compose file; never `unconfined`.
    security_opt: ["no-new-privileges:true", "seccomp=./seccomp/buildkit.json"],
    command: ["--addr", "tcp://0.0.0.0:1234", "--oci-worker-no-process-sandbox"],
    volumes: ["buildkit-state:/home/user/.local/share/buildkit"],
    tmpfs: ["/tmp:size=512m,nosuid,nodev"],
    networks: ["build", "build_egress"],
    labels: { "run.vyre.publish": "1", "vyre.publish.role": "build" },
  };
  if (!usesEgress) delete networks.egress;

  /** @type {Record<string, any>} */
  const compose = {
    name: project,
    services,
    networks,
    volumes,
    configs: { caddyfile: { file: "./Caddyfile" }, joinpage: { file: "./join.html" } },
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
  assertIsolated(compose);
  return compose;
}

/** compose reads JSON as YAML, so the text form is JSON. @param {any} compose */
export const composeText = compose => JSON.stringify(compose, null, 2) + "\n";

const SERVICE_KEYS = new Set(["image", "command", "restart", "read_only", "cap_drop", "security_opt", "user", "tmpfs", "mem_limit", "cpus", "pids_limit", "networks", "ports", "volumes", "secrets", "configs", "environment", "labels", "init", "logging", "sysctls"]);
const TOP_KEYS = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);
const CADDY_PORTS = Object.freeze(["80:80", "443:443", "443:443/udp"]);
/** The loopback port the tunnel end dials. Fixed: the relay never names an address. */
export const TUNNEL_PORT = 18443;
const CADDY_PORTS_TUNNEL = Object.freeze([`127.0.0.1:${TUNNEL_PORT}:443`]);

/**
 * Every isolation invariant, on any compose object. Returns the list of problems (empty means isolated).
 * @param {any} compose @returns {string[]}
 */
export function isolationProblems(compose) {
  /** @type {string[]} */ const p = [];
  if (!compose || typeof compose !== "object") return ["not a compose object"];
  for (const k of Object.keys(compose)) if (!TOP_KEYS.has(k)) p.push(`top-level ${k} is not allowed`);
  if (!/^vyre-publish-spc_[a-z0-9]{12}$/.test(compose.name || "")) p.push("project name must be vyre-publish-<spaceId>");
  const services = compose.services && typeof compose.services === "object" ? compose.services : {};
  const nets = compose.networks && typeof compose.networks === "object" ? compose.networks : {};
  const vols = compose.volumes && typeof compose.volumes === "object" ? compose.volumes : {};
  const secs = compose.secrets && typeof compose.secrets === "object" ? compose.secrets : {};
  if (!services.caddy) p.push("caddy service missing");
  if (!services.buildkit) p.push("buildkit service missing");

  for (const [n, d] of Object.entries(nets)) {
    const def = /** @type {any} */ (d) || {};
    if (def.external) p.push(`network ${n} is external`);
    if (def.name) p.push(`network ${n} names an existing network`);
    if (def.driver && def.driver !== "bridge") p.push(`network ${n} driver ${def.driver} is not allowed`);
    if (def.driver_opts) p.push(`network ${n} sets driver options`);
    if (FORBIDDEN_NETWORK_WORDS.test(n)) p.push(`network ${n} is named like a space or control network`);
    if ((n === "build" || n.startsWith("wl-")) && def.internal !== true) p.push(`network ${n} must be internal`);
    if (n !== "edge" && n !== "build" && n !== "build_egress" && n !== "egress" && !/^wl-[0-9a-f]{16}$/.test(n)) p.push(`network ${n} is not one of the edge's own`);
  }
  for (const [n, d] of Object.entries(vols)) {
    const def = /** @type {any} */ (d) || {};
    if (def.external) p.push(`volume ${n} is external`);
    if (def.driver && def.driver !== "local") p.push(`volume ${n} driver ${def.driver} is not allowed`);
    if (def.driver_opts) p.push(`volume ${n} sets driver options (a bind in disguise)`);
    if (def.name) p.push(`volume ${n} names an existing volume`);
    if (!/^(caddy-data|caddy-config|buildkit-state|site-[0-9a-f]{16})$/.test(n)) p.push(`volume ${n} is not one of the edge's own`);
  }
  for (const [n, d] of Object.entries(secs)) {
    const def = /** @type {any} */ (d) || {};
    if (def.external || def.environment || !/^\.\/secrets\/dep_[0-9a-f]{16}\/[A-Z][A-Z0-9_]{0,63}$/.test(def.file || "")) p.push(`secret ${n} must be a per-deployment file under ./secrets`);
  }
  if (compose.configs) for (const [n, d] of Object.entries(compose.configs)) if (!((n === "caddyfile" && /** @type {any} */ (d).file === "./Caddyfile") || (n === "joinpage" && /** @type {any} */ (d).file === "./join.html"))) p.push(`config ${n} is not one of the edge's own files`);

  /** @type {Map<string, string[]>} */ const volUsers = new Map(), netUsers = new Map();
  for (const [name, raw] of Object.entries(services)) {
    const s = /** @type {any} */ (raw) || {};
    for (const k of Object.keys(s)) if (!SERVICE_KEYS.has(k)) p.push(`${name}: ${k} is not allowed`);
    if (typeof s.image !== "string" || !IMAGE_RE.test(s.image)) p.push(`${name}: image missing or invalid`);
    if (s.read_only !== true) p.push(`${name}: root filesystem must be read-only`);
    if (!(Array.isArray(s.cap_drop) && s.cap_drop.includes("ALL"))) p.push(`${name}: cap_drop must be ALL`);
    if (s.cap_add) p.push(`${name}: cap_add is not allowed`);
    const so = Array.isArray(s.security_opt) ? s.security_opt : [];
    if (!so.includes("no-new-privileges:true")) p.push(`${name}: no-new-privileges is required`);
    for (const o of so) if (o !== "no-new-privileges:true" && !(typeof o === "string" && /^seccomp=\.\/seccomp\/[a-z0-9._-]+\.json$/.test(o))) p.push(`${name}: security option ${String(o)} is not allowed`);
    if (!s.mem_limit || !s.cpus || !s.pids_limit) p.push(`${name}: memory, cpu and pid limits are required`);
    if (s.sysctls) for (const [k, v] of Object.entries(s.sysctls)) if (!(name === "caddy" && k === "net.ipv4.ip_unprivileged_port_start" && v === 0)) p.push(`${name}: sysctl ${k} is not allowed`);
    if (typeof s.user === "string" && /^(0|root)(:|$)/.test(s.user)) p.push(`${name}: must not run as root`);
    // ports
    if (s.ports) { if (name !== "caddy" || ![CADDY_PORTS, CADDY_PORTS_TUNNEL].some(ok => JSON.stringify(s.ports) === JSON.stringify(ok))) p.push(`${name}: only caddy publishes 80 and 443 (or its loopback tunnel port)`); }
    // volumes: named only
    for (const v of s.volumes || []) {
      if (typeof v !== "string") { p.push(`${name}: object-form volume is not allowed`); continue; }
      const src = v.split(":")[0];
      if (!/^[a-z0-9][a-z0-9-]*$/.test(src) || !(src in vols)) p.push(`${name}: volume source ${src} is not one of the edge's own named volumes (no bind mounts)`);
      else (volUsers.get(src) || volUsers.set(src, []).get(src))?.push(name);
    }
    for (const t of s.tmpfs || []) if (typeof t !== "string" || !t.startsWith("/tmp")) p.push(`${name}: tmpfs only under /tmp`);
    // networks
    const sn = Array.isArray(s.networks) ? s.networks : [];
    if (!sn.length) p.push(`${name}: must name its networks`);
    for (const n of sn) { if (!(n in nets)) p.push(`${name}: network ${n} is not declared by the edge`); (netUsers.get(n) || netUsers.set(n, []).get(n))?.push(name); }
    if (name === "buildkit") { if (sn.some((/** @type {string} */ n) => n !== "build" && n !== "build_egress")) p.push("buildkit may be on the build networks only"); }
    else if (name === "caddy") { if (sn.includes("build") || sn.includes("build_egress")) p.push("caddy must not join the build networks"); if (!sn.includes("edge")) p.push("caddy must be on the edge network"); }
    else {
      const own = `wl-${name.replace(/^w-/, "")}`;
      if (!/^w-[0-9a-f]{16}$/.test(name)) p.push(`${name}: not a workload service name`);
      if (!sn.includes(own)) p.push(`${name}: must be on its own network ${own}`);
      // The egress bridge reaches the host and private ranges and nothing enforces its allow-list yet, so no workload joins it (EG-1).
      for (const n of sn) if (n !== own) p.push(`${name}: network ${n} is not allowed for a workload`);
    }
    // env
    const env = s.environment && typeof s.environment === "object" && !Array.isArray(s.environment) ? s.environment : {};
    if (Array.isArray(s.environment)) p.push(`${name}: environment must be a map`);
    if (name === "caddy" || name === "buildkit") { if (Object.keys(env).length) p.push(`${name}: takes no environment`); }
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME_RE.test(k) || (isSpaceEnvName(k) && !/_FILE$/.test(k))) p.push(`${name}: env ${k} looks like a space variable`);
      if (typeof v === "string" && SECRET_REF_RE.test(v)) p.push(`${name}: env ${k} holds a secret reference`);
    }
    // secrets: only this workload's own
    for (const sc of s.secrets || []) {
      const slug = name.replace(/^w-/, "");
      if (!sc || typeof sc.source !== "string" || !sc.source.startsWith(slug + "_") || !(sc.source in secs)) p.push(`${name}: secret ${sc && sc.source} is not granted to this deployment`);
      else if (secs[sc.source].file.split("/")[2] !== `dep_${slug}`) p.push(`${name}: secret ${sc.source} belongs to another deployment`);
    }
    if ((s.secrets || []).length && (name === "caddy" || name === "buildkit")) p.push(`${name}: takes no secrets`);
  }
  for (const [v, users] of volUsers) if (users.length > 1) p.push(`volume ${v} is shared by ${users.join(", ")}`);
  for (const [n, users] of netUsers) {
    if (n.startsWith("wl-") && users.some(u => u !== "caddy" && u !== `w-${n.slice(3)}`)) p.push(`network ${n} is shared with another service`);
    if (n === "build" && users.some(u => u !== "buildkit")) p.push("only buildkit is on the build network");
  }
  const text = JSON.stringify(compose);
  for (const f of FORBIDDEN_TEXT) if (text.includes(f)) p.push(`forbidden text ${f}`);
  return p;
}

/** @param {any} compose @returns {true} */
export function assertIsolated(compose) {
  const problems = isolationProblems(compose);
  if (problems.length) fail("isolation", `the edge is not isolated: ${problems[0]}`, { problems });
  return true;
}

/**
 * The Caddyfile. Automatic HTTPS only for hosts written here: verified domains and generated hosts. Never on-demand TLS.
 * @param {Array<{ host: string, verified: boolean, deployment: string, canonical?: "apex" | "www" | null, www?: boolean }>} domains
 * @param {Array<{ id: string, name?: string, kind: "static" | "node", port?: number, stage?: string }>} workloads
 * @param {{ spaceName: string, tunnel?: boolean }} opts `tunnel`: no port 80 reaches Caddy, so no http to https redirect listener; certificates come over 443 (TLS-ALPN)
 */
export function caddyfile(domains, workloads, opts) {
  const spaceName = opts && opts.spaceName;
  normalizeHost(spaceName);
  /** @type {string[]} */ const blocks = [];
  const wmap = new Map();
  for (const w of workloads) {
    if (!DEPLOYMENT_ID_RE.test(w.id)) fail("bad_input", "bad workload id");
    if (w.kind !== "static" && w.kind !== "node") fail("bad_input", "bad workload kind");
    const port = w.kind === "static" ? STATIC_PORT : w.port;
    if (!Number.isInteger(port) || /** @type {number} */ (port) < 1024 || /** @type {number} */ (port) > 65535) fail("bad_input", "bad workload port");
    wmap.set(w.id, { ...w, port });
  }
  const head = [
    "# Generated by Vyre Publish. Do not edit; changes are overwritten.",
    "{",
    "\tadmin off",
    ...(opts.tunnel === true ? ["\tauto_https disable_redirects"] : []),
    "\tservers {",
    "\t\ttimeouts {",
    "\t\t\tread_header 10s",
    "\t\t\tread_body 30s",
    "\t\t\twrite 60s",
    "\t\t\tidle 2m",
    "\t\t}",
    "\t\tmax_header_size 16KB",
    "\t}",
    "}",
    "",
    "(secure) {",
    "\tencode zstd gzip",
    "\theader {",
    '\t\tStrict-Transport-Security "max-age=31536000"',
    '\t\tX-Content-Type-Options "nosniff"',
    '\t\tX-Frame-Options "SAMEORIGIN"',
    '\t\t?Referrer-Policy "strict-origin-when-cross-origin"',
    '\t\tPermissions-Policy "camera=(), microphone=(), geolocation=()"',
    "\t\t-Server",
    "\t}",
    "\trequest_body {",
    "\t\tmax_size 10MB",
    "\t}",
    "\tlog {",
    "\t\toutput stdout",
    "\t\tformat filter {",
    "\t\t\twrap json",
    "\t\t\tfields {",
    '\t\t\t\trequest>uri regexp \\?.* ""',
    // A join link carries a one-time token in its path: the log keeps /join/redacted and never the token (reviewer-3, JP-1).
    '\t\t\t\trequest>uri regexp ^(/join/).* ${1}redacted',
    '\t\t\t\trequest>headers>Referer regexp \\?.* ""',
    "\t\t\t\trequest>headers>Authorization delete",
    "\t\t\t\trequest>headers>Cookie delete",
    "\t\t\t\tresp_headers>Set-Cookie delete",
    "\t\t\t}",
    "\t\t}",
    "\t}",
    "}",
    "",
  ];
  // A static site never serves a dotfile or a dot folder (.env, .git, .htpasswd): the file server would, so the edge answers 404 first. /.well-known/ stays reachable.
  const noDotfiles = ["\t@dotfiles {", "\t\tpath_regexp (^|/)\\.[^/]", "\t\tnot path /.well-known/*", "\t}", "\trespond @dotfiles 404"];
  const proxy = (/** @type {any} */ w) => [
    "\timport secure",
    ...(w.kind === "static" ? noDotfiles : []),
    `\treverse_proxy ${serviceName(w.id)}:${w.port} {`,
    "\t\ttransport http {",
    "\t\t\tdial_timeout 5s",
    "\t\t\tresponse_header_timeout 30s",
    "\t\t}",
    "\t}",
  ];
  const seenHosts = new Set();
  /** @param {string} host @param {string[]} body */
  const site = (host, body) => {
    if (seenHosts.has(host)) fail("duplicate", "a host is listed twice");
    seenHosts.add(host);
    blocks.push([`${host} {`, ...body, "}"].join("\n"));
  };

  // The page behind a join link, on the space's own name: one fixed page, nothing proxied (see join.js). Anything else on that host is 404.
  site(spaceName, [
    "\timport secure",
    "\t@join path_regexp ^/join/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    "\thandle @join {",
    '\t\theader Content-Type "text/html; charset=utf-8"',
    '\t\theader Cache-Control "no-store"',
    '\t\theader Referrer-Policy "no-referrer"',
    `\t\theader Content-Security-Policy "${JOIN_CSP}"`,
    '\t\theader X-Robots-Tag "noindex, nofollow"',
    "\t\troot * /srv/join",
    "\t\trewrite * /index.html",
    "\t\tfile_server",
    "\t}",
    "\trespond 404",
  ]);

  // Production workloads: their verified domains, or the generated default host when none.
  for (const w of wmap.values()) {
    if (w.stage === "Preview" || w.stage === "Approved") {
      const h = previewHost(w.id, spaceName);
      site(h, ['\theader X-Robots-Tag "noindex, nofollow"', ...proxy(w)]);
    }
  }
  for (const w of wmap.values()) {
    if (w.stage !== "Production") continue;
    const mine = domains.filter(d => d.deployment === w.id && d.verified === true);
    if (!mine.length) { site(defaultHost(w.name || "", spaceName), proxy(w)); continue; }
    for (const d of mine) {
      const host = normalizeHost(d.host).ascii;
      if (host.endsWith(".vyre.run") && host.split(".").length !== 3) fail("bad_domain", "bad vyre.run host");
      const isWww = host.startsWith("www.");
      const apex = isWww ? host.slice(4) : host;
      const apexLike = host.split(".").length === 2 && !host.endsWith(".vyre.run");
      const wantsWww = !isWww && (d.www === true || (d.www !== false && apexLike)) && !!normalizeHost("www." + host, { generated: true }).ascii;
      const canonicalWww = d.canonical === "www" && !isWww;
      if (canonicalWww) {
        site(`www.${host}`, proxy(w));
        site(host, ["\timport secure", "\tredir https://www." + host + "{uri} permanent"]);
      } else {
        site(host, proxy(w));
        if (wantsWww) site(`www.${host}`, ["\timport secure", "\tredir https://" + host + "{uri} permanent"]);
      }
      void apex;
    }
  }
  return head.join("\n") + blocks.join("\n\n") + (blocks.length ? "\n" : "");
}
