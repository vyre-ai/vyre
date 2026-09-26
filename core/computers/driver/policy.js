// @ts-check
// policy: the exact create body and the exact exec that an agent's container is allowed, as a
// function of the request and the box's own config — no network, no state beyond that config,
// nothing but the shapes in docs/adr/0009-container-hardening.md.
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
//
// What this file cannot do alone, from security's review (26 Sep) — the proxy itself must:
//   - inspect a volume that already exists before letting a create reuse it (VolumeOptions.Labels
//     only take effect when Docker makes a NEW volume; naming an existing one bypasses them
//     entirely), and refuse unless that volume's own labels name the same agent as the body;
//   - allowlist the endpoints themselves (create, start, stop, pause, unpause, inspect, list,
//     remove, exec and exec-start on computer containers, volume inspect) and keep everything
//     else shut, /containers/*/archive, /images/create and /build above all;
//   - never let this file's exec check, or allowCreate's own labels check, stand in for keeping
//     Claude's own sessions off this network at all: a caller naming a DIFFERENT agent still
//     reaches that agent's real computer and its real home volume, since both checks only ask
//     "is this a computer" and "does the claim match what is really there," never "is the
//     caller allowed to act as this particular agent." No label check closes that - only vyred
//     being the only caller who can reach these endpoints at all does. Noted below on both
//     functions as residual until Claude's sessions have their own container.

/**
 * Every container and volume this file's own labels touch carries a fixed `run.vyre: "1"` marker
 * (docker.js), independent of whatever `computers.labelPrefix` a box configures — but box's own
 * infrastructure containers (docker-api, tailscale, vyre itself) carry that same fixed marker
 * too, so it alone cannot tell an agent's computer apart from vyred's own container. The
 * `<prefix>.managed=true` / `<prefix>.computer=<agent>` pair is the real discriminator, and the
 * prefix is configurable, so this looks for the shape rather than a literal key.
 * @param {Record<string, any>} labels
 * @returns {{ prefix: string, agent: string } | null}
 */
export function computerLabels(labels) {
  if (!labels || typeof labels !== "object") return null;
  if (labels["run.vyre"] !== "1") return null;
  const managed = Object.entries(labels).find(([k, v]) => k.endsWith(".managed") && v === "true");
  const computer = Object.entries(labels).find(([k, v]) => k.endsWith(".computer") && typeof v === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(v));
  if (!managed || !computer) return null;
  const prefix = managed[0].slice(0, -".managed".length);
  if (prefix !== computer[0].slice(0, -".computer".length)) return null;
  return { prefix, agent: String(computer[1]) };
}

/** @param {Record<string, any>} labels */
export const isComputerLabels = labels => computerLabels(labels) !== null;

/**
 * Like `computerLabels`, but for a request that has not been created yet, where the caller
 * chooses every label in the body — including which prefix to use, and with `.find()`, which of
 * two pairs to match if it sends more than one. Pinning to the box's own configured
 * `labelPrefix` closes both: only `${labelPrefix}.managed`/`${labelPrefix}.computer` count, and
 * any OTHER `*.managed`/`*.computer`-shaped key anywhere in the labels refuses the whole body,
 * rather than being silently ignored (security, 26 Sep — a caller was otherwise free to pick its
 * own prefix, and with it the volume name `isVolumeMount` derives from it).
 * @param {Record<string, any>} labels @param {string} labelPrefix
 * @returns {{ prefix: string, agent: string } | null}
 */
function claimedComputerLabels(labels, labelPrefix) {
  if (!labels || typeof labels !== "object") return null;
  if (labels["run.vyre"] !== "1") return null;
  const shaped = k => k.endsWith(".managed") || k.endsWith(".computer");
  const others = Object.keys(labels).filter(k => shaped(k) && k !== `${labelPrefix}.managed` && k !== `${labelPrefix}.computer`);
  if (others.length) return null;
  if (labels[`${labelPrefix}.managed`] !== "true") return null;
  const agent = labels[`${labelPrefix}.computer`];
  if (typeof agent !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(agent)) return null;
  return { prefix: labelPrefix, agent };
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

/**
 * Real Linux capabilities that turn "unprivileged container" into "root on the box" or "read any
 * process's memory" on their own - refused even if a box misconfigures computers.capAdd to
 * include one. The image needs none of them (Xvnc, Chrome --no-sandbox, AT-SPI and xdotool all
 * run as a normal user); computers.capAdd exists for whatever a future box finds it genuinely
 * needs, and none of these is ever going to be that.
 */
const FORBIDDEN_CAPS = new Set(["SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "NET_ADMIN", "DAC_READ_SEARCH", "SYS_RAWIO"]);

/**
 * @param {{ network: string, image: string, labelPrefix: string, capAdd?: string[] }} config the
 *   box's own computers.network / computers.image / computers.labelPrefix / computers.capAdd,
 *   never taken from the request
 */
function hostConfigShape(config, expectAgent) {
  const capAdd = new Set((config.capAdd || []).map(String));
  return {
    NetworkMode: { required: true, is: eq(config.network) },
    PidMode: { required: true, is: eq("") },
    NanoCpus: { required: true, is: isPosInt },
    Memory: { required: true, is: isPosInt },
    PortBindings: { required: true, is: isEmptyObj },
    PublishAllPorts: { required: true, is: eq(false) },
    Privileged: { required: true, is: eq(false) },
    CapDrop: { required: true, is: eq(["ALL"]) },
    // Exactly the box's own configured set (default none), and never one of FORBIDDEN_CAPS -
    // config cannot turn this file into a rubber stamp for root-equivalent capabilities.
    CapAdd: { is: v => Array.isArray(v) && v.every(c => isStr(c) && capAdd.has(c) && !FORBIDDEN_CAPS.has(c)) },
    Devices: { required: true, is: eq([]) },
    SecurityOpt: { required: true, is: eq(["no-new-privileges"]) },
    ReadonlyRootfs: { required: true, is: eq(true) },
    Tmpfs: { required: true, is: v => v && typeof v === "object" && !Array.isArray(v)
      && Object.keys(v).every(p => ["/tmp", "/run", "/var/run"].includes(p)) && Object.values(v).every(isStr) },
    ShmSize: { required: true, is: isPosInt },
    Mounts: { required: true, is: v => Array.isArray(v) && v.length === 1 && isVolumeMount(v[0], config, expectAgent) },
    RestartPolicy: { required: true, is: eq({ Name: "no" }) },
  };
}

/**
 * The one mount a computer ever gets: its own named volume at /home/agent, never a bind, never
 * an existing volume that happens to carry the right name by coincidence or by an attacker's
 * own choosing of both the label and the source together. `Source` must be exactly the name
 * docker.js derives for this agent (`<prefix>-home-<agent>`), so a caller cannot mount vyred's
 * own home (which holds vault keys) or another agent's by naming it directly.
 *
 * This still is not the whole guard: Docker only applies VolumeOptions.Labels when it CREATES a
 * new volume by this name. If one already exists, Docker mounts it and ignores the labels this
 * body asks for outright - so the proxy itself must inspect an existing volume of this name
 * before allowing the create, and refuse unless that volume's own labels already name this same
 * agent (security, 26 Sep). This function checks what the body claims; it cannot check what the
 * Engine already has under that name.
 * @param {any} m @param {{ network: string, image: string, labelPrefix: string, capAdd?: string[] }} config
 * @param {{ prefix: string, agent: string }} expectAgent from the body's own top-level Labels, pinned to config.labelPrefix
 */
function isVolumeMount(m, config, expectAgent) {
  if (!m || typeof m !== "object") return false;
  if (m.Type !== "volume") return false;
  if (m.Target !== "/home/agent") return false;
  if (m.Source !== `${expectAgent.prefix}-home-${expectAgent.agent}`) return false;
  const opts = m.VolumeOptions;
  if (!opts || typeof opts !== "object") return false;
  const got = claimedComputerLabels(opts.Labels, config.labelPrefix);
  return Boolean(got && got.agent === expectAgent.agent);
}

/**
 * @param {{ network: string, image: string, labelPrefix: string, capAdd?: string[] }} config
 */
function bodyShape(config) {
  return {
    // Pinned to the box's own configured image: a direct caller cannot run something else on
    // the computers network next to other agents' computerd. Not by digest (this file has no
    // registry access to resolve one) - a box that wants that pins computers.image to a
    // `name@sha256:...` reference, which an exact string match here already accepts as-is.
    Image: { required: true, is: eq(config.image) },
    Hostname: { required: true, is: v => isStr(v) && /^[a-z][a-z0-9-]{0,40}$/.test(v) },
    Env: { required: true, is: v => Array.isArray(v) && v.every(e => isStr(e) && /^[A-Z_][A-Z0-9_]*=/.test(e)) },
    // Pinned to config.labelPrefix, not just any *.managed/*.computer pair the body picks: a
    // caller choosing its own prefix would also choose the volume Source isVolumeMount derives
    // from it (security, 26 Sep).
    Labels: { required: true, is: (v, body) => Boolean(claimedComputerLabels(v, config.labelPrefix)) },
    ExposedPorts: { required: true, is: v => v && typeof v === "object" && !Array.isArray(v)
      && Object.keys(v).every(p => /^\d{1,5}\/tcp$/.test(p)) && Object.values(v).every(isEmptyObj) },
    HostConfig: { required: true, is: (v, body) => {
      const expectAgent = claimedComputerLabels(body.Labels, config.labelPrefix);
      return Boolean(expectAgent) && checkShape(v, hostConfigShape(config, expectAgent), "HostConfig") === null;
    } },
  };
}

// checkShape's `is` only ever received the field's own value; HostConfig's rule needs the whole
// body too (to cross-check Mounts[0].Source against Labels), so this variant passes it through.
function checkBodyShape(obj, allowed, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return `${where} must be an object`;
  for (const k of Object.keys(obj)) if (!allowed[k]) return `${where}.${k} is not a field this create is allowed to set`;
  for (const [k, rule] of Object.entries(allowed)) {
    if (!(k in obj)) { if (rule.required) return `${where}.${k} is required`; continue; }
    if (!rule.is(obj[k], obj)) return `${where}.${k} has a value this create is not allowed to set`;
  }
  return null;
}

/**
 * May a `POST /containers/create` with this body go to the Engine? `body` is exactly what the
 * proxy is about to forward, parsed JSON. `config` is the box's own `computers.network`,
 * `computers.image` and `computers.capAdd` - never anything from the request - so a direct
 * caller cannot choose its own network, image or capability just by asking. Everything ADR 0009
 * hard-codes is checked too, so a caller that reaches the proxy directly gets the same floor
 * `DockerDriver.create()` gives one that goes through it.
 *
 * The proxy must still do its own part beside this: inspect an existing volume of the derived
 * name before letting a create reuse it (see `isVolumeMount`'s doc), and allowlist which
 * endpoints reach the Engine at all.
 *
 * Residual, not closed by this check (security, 26 Sep): a caller naming a different agent in
 * Labels gets that agent's own existing volume back (its Source is derived from the claim, and
 * the proxy's own volume check then finds that agent's real labels on it, which match) — cross-
 * agent access to a home volume, the same class as `allowExec`'s residual below and closed the
 * same way, once Claude's own sessions are off this network and vyred is the only caller left.
 * @param {any} body @param {{ network: string, image: string, labelPrefix: string, capAdd?: string[] }} config
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function allowCreate(body, config) {
  if (!config || !isStr(config.network) || !isStr(config.image) || !isStr(config.labelPrefix)) {
    throw new Error("allowCreate needs the box's own computers.network, computers.image and computers.labelPrefix, never taken from the request");
  }
  const why = checkBodyShape(body, bodyShape(config), "body");
  return why ? { ok: false, why } : { ok: true };
}

/**
 * May `POST /containers/<id>/exec` (or an attach to one) reach this container? `labels` is what
 * the Engine's own inspect of `id` says, read by the proxy itself, never trusted from the
 * request — a caller cannot claim a container is a computer's by naming it in the body. `cmd` is
 * not restricted here: a computer's own hardening (no capabilities, a read-only root, a normal
 * user) bounds what an exec inside it can do; this only says which containers are open to one at
 * all, never vyred's own container, docker-api's, or the box's other services.
 *
 * Residual, not closed by this check (security, 26 Sep): any agent's computer passes this, so a
 * caller that can reach exec at all still has cross-agent access - agent B's Chrome profile and
 * session, from a request that only ever claimed to be acting for A. Labels tell a computer
 * apart from everything else on the box; they cannot tell one agent's computer apart from
 * another's, because both carry the identical shape by design. Closing that needs the caller to
 * be vyred and nothing else - true once Claude's own sessions have their own container, off this
 * network entirely. Until then this is a floor, not the guarantee.
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
 * remove, volume inspect): the same container check as exec, since none of them takes a body
 * worth checking.
 * @param {Record<string, any>} labels
 */
export const allowContainerOp = labels => allowExec(labels);
