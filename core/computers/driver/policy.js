// @ts-check
// policy: the exact create body and the exact exec that an agent's container is allowed, as a
// pure function of the request — no network, no state, nothing but the shapes in
// docs/adr/0009-container-hardening.md.
//
// This exists because that ADR's hardening lives in DockerDriver.create(), and holds only for
// requests that actually go through it. A caller that reaches the restricted proxy directly
// (found: a Claude session's own Bash, sharing vyred's container and network namespace) can send
// any body it likes, and a proxy that only filters endpoints — never bodies — would forward it.
// box's proxy imports this file and calls allowCreate()/allowExec() on every request those
// endpoints allow, so the hardening holds even when DockerDriver is bypassed entirely. It is the
// one place both the proxy and docker.js's own tests agree on what a create body may look like:
// docker.test.js and policy.test.js are built from the same fixture.
//
// Everything here is an allowlist, not a denylist: an unknown key anywhere is refused, the same
// direction as consequence.js's "cannot read what this control does, so it is treated as one
// that matters" — a HostConfig field this file has never seen is not assumed safe.

/**
 * Every container and volume this file's own labels touch carries a fixed `run.vyre: "1"` marker
 * (docker.js), independent of whatever `computers.labelPrefix` a box configures — but box's own
 * infrastructure containers (docker-api, tailscale, vyre itself) carry that same fixed marker
 * too, so it alone cannot tell an agent's computer apart from vyred's own container. The
 * `<prefix>.managed=true` / `<prefix>.computer=<agent>` pair is the real discriminator, and the
 * prefix is configurable, so this looks for the shape rather than a literal key.
 * @param {Record<string, any>} labels
 */
export function isComputerLabels(labels) {
  if (!labels || typeof labels !== "object") return false;
  if (labels["run.vyre"] !== "1") return false;
  const managed = Object.entries(labels).find(([k, v]) => k.endsWith(".managed") && v === "true");
  const computer = Object.entries(labels).find(([k, v]) => k.endsWith(".computer") && typeof v === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(v));
  return Boolean(managed && computer && managed[0].slice(0, -".managed".length) === computer[0].slice(0, -".computer".length));
}

/**
 * Refuse anything not in `allowed`, keyed by name, each an exact-match value or a `(v) => bool`
 * check. Every key of `obj` must be in `allowed`, and every key of `allowed` marked required must
 * be in `obj` — an allowlist checks both directions, or a field silently dropped would pass too.
 * @param {Record<string, any>} obj
 * @param {Record<string, { required?: boolean, is: (v: any) => boolean }>} allowed
 * @param {string} where
 * @returns {string|null} why it was refused, or null if it was not
 */
function checkShape(obj, allowed, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return `${where} must be an object`;
  for (const k of Object.keys(obj)) if (!allowed[k]) return `${where}.${k} is not a field this create is allowed to set`;
  for (const [k, rule] of Object.entries(allowed)) {
    if (!(k in obj)) { if (rule.required) return `${where}.${k} is required`; continue; }
    if (!rule.is(obj[k])) return `${where}.${k} has a value this create is not allowed to set`;
  }
  return null;
}

const eq = expected => v => JSON.stringify(v) === JSON.stringify(expected);
const isStr = v => typeof v === "string";
const isPosInt = v => Number.isInteger(v) && v > 0;
const isEmptyObj = v => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;

const HOST_CONFIG_SHAPE = {
  NetworkMode: { is: v => isStr(v) && v !== "host" },
  PidMode: { required: true, is: eq("") },
  NanoCpus: { required: true, is: isPosInt },
  Memory: { required: true, is: isPosInt },
  PortBindings: { required: true, is: isEmptyObj },
  PublishAllPorts: { required: true, is: eq(false) },
  Privileged: { required: true, is: eq(false) },
  CapDrop: { required: true, is: eq(["ALL"]) },
  // The one escape hatch (computers.capAdd), a box's own explicit config, never a default here.
  CapAdd: { is: v => Array.isArray(v) && v.every(isStr) },
  Devices: { required: true, is: eq([]) },
  SecurityOpt: { required: true, is: eq(["no-new-privileges"]) },
  ReadonlyRootfs: { required: true, is: eq(true) },
  Tmpfs: { required: true, is: v => v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).every(p => ["/tmp", "/run", "/var/run"].includes(p)) && Object.values(v).every(isStr) },
  ShmSize: { required: true, is: isPosInt },
  Mounts: { required: true, is: v => Array.isArray(v) && v.length === 1 && isVolumeMount(v[0]) },
  RestartPolicy: { required: true, is: eq({ Name: "no" }) },
};

/** The one mount a computer ever gets: its own named volume at /home/agent, never a bind. */
function isVolumeMount(m) {
  if (!m || typeof m !== "object") return false;
  if (m.Type !== "volume") return false;
  if (m.Target !== "/home/agent") return false;
  if (typeof m.Source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}$/.test(m.Source)) return false;
  const opts = m.VolumeOptions;
  if (!opts || typeof opts !== "object") return false;
  return isComputerLabels(opts.Labels);
}

const BODY_SHAPE = {
  Image: { required: true, is: isStr },
  Hostname: { required: true, is: v => isStr(v) && /^[a-z][a-z0-9-]{0,40}$/.test(v) },
  Env: { required: true, is: v => Array.isArray(v) && v.every(e => isStr(e) && /^[A-Z_][A-Z0-9_]*=/.test(e)) },
  Labels: { required: true, is: isComputerLabels },
  ExposedPorts: { required: true, is: v => v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).every(p => /^\d{1,5}\/tcp$/.test(p)) && Object.values(v).every(isEmptyObj) },
  HostConfig: { required: true, is: v => checkShape(v, HOST_CONFIG_SHAPE, "HostConfig") === null },
};

/**
 * May a `POST /containers/create` with this body go to the Engine? `body` is exactly what the
 * proxy is about to forward, parsed JSON. Everything ADR 0009 hard-codes is checked here too, so
 * a caller that reaches the proxy directly gets the same floor `DockerDriver.create()` gives one
 * that goes through it.
 * @param {any} body
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function allowCreate(body) {
  const why = checkShape(body, BODY_SHAPE, "body");
  return why ? { ok: false, why } : { ok: true };
}

/**
 * May `POST /containers/<id>/exec` (or an attach to one) reach this container? `labels` is what
 * the Engine's own inspect of `id` says, read by the proxy itself, never trusted from the
 * request — a caller cannot claim a container is a computer's by naming it in the body. `cmd` is
 * not restricted here: a computer's own hardening (no capabilities, a read-only root, a normal
 * user) bounds what an exec inside it can do; this only says which containers are open to one at
 * all, never vyred's own container, docker-api's, or the box's other services.
 * @param {Record<string, any>} labels @param {string[]} [cmd]
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function allowExec(labels, cmd) {
  if (cmd !== undefined && !(Array.isArray(cmd) && cmd.every(isStr))) return { ok: false, why: "cmd must be a list of strings" };
  if (!isComputerLabels(labels)) return { ok: false, why: "not an agent's computer (missing the managed/computer label pair)" };
  return { ok: true };
}

/**
 * The other operations the proxy lets through (start, stop, pause, unpause, inspect, list,
 * remove): the same container check as exec, since none of them takes a body worth checking.
 * @param {Record<string, any>} labels
 */
export const allowContainerOp = labels => allowExec(labels);
