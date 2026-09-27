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
 * What every computer gets, whatever computers.capAdd says: the image starts as root only to
 * start Xvnc, computerd and Chrome as one user and the agent's desktop as another (entrypoint.sh,
 * setpriv). Neither lets a process read or trace another's memory, and with no-new-privileges and
 * a read-only root there is no setuid file to turn them into more.
 */
export const REQUIRED_CAPS = Object.freeze(["SETUID", "SETGID"]);

/** The volumes a computer mounts, where, and the name each must have for its agent. */
const VOLUMES = Object.freeze([
  { target: "/home/agent", name: (prefix, agent) => `${prefix}-home-${agent}` },
  { target: "/var/lib/vyre", name: (prefix, agent) => `${prefix}-browser-${agent}` },
]);

/**
 * @param {{ network: string, image: string, labelPrefix: string, capAdd?: string[] }} config the
 *   box's own computers.network / computers.image / computers.labelPrefix / computers.capAdd,
 *   never taken from the request
 */
function hostConfigShape(config, expectAgent) {
  const capAdd = new Set([...REQUIRED_CAPS, ...(config.capAdd || []).map(String)]);
  return {
    NetworkMode: { required: true, is: eq(config.network) },
    PidMode: { required: true, is: eq("") },
    NanoCpus: { required: true, is: isPosInt },
    Memory: { required: true, is: isPosInt },
    PortBindings: { required: true, is: isEmptyObj },
    PublishAllPorts: { required: true, is: eq(false) },
    Privileged: { required: true, is: eq(false) },
    CapDrop: { required: true, is: eq(["ALL"]) },
    // REQUIRED_CAPS plus the box's own configured set (default none), and never one of FORBIDDEN_CAPS -
    // config cannot turn this file into a rubber stamp for root-equivalent capabilities.
    CapAdd: { is: v => Array.isArray(v) && v.every(c => isStr(c) && capAdd.has(c) && !FORBIDDEN_CAPS.has(c)) },
    Devices: { required: true, is: eq([]) },
    SecurityOpt: { required: true, is: eq(["no-new-privileges"]) },
    ReadonlyRootfs: { required: true, is: eq(true) },
    Tmpfs: { required: true, is: v => v && typeof v === "object" && !Array.isArray(v)
      && Object.keys(v).every(p => ["/tmp", "/run", "/var/run"].includes(p)) && Object.values(v).every(isStr) },
    ShmSize: { required: true, is: isPosInt },
    Mounts: { required: true, is: v => Array.isArray(v) && v.length === VOLUMES.length && VOLUMES.every((vol, i) => isVolumeMount(v[i], config, expectAgent, vol)) },
    RestartPolicy: { required: true, is: eq({ Name: "no" }) },
  };
}

/**
 * The two mounts a computer ever gets, in order: its home volume at /home/agent and its browser
 * volume at /var/lib/vyre (VOLUMES). Each is its own named volume, never a bind, never
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
function isVolumeMount(m, config, expectAgent, vol = VOLUMES[0]) {
  if (!m || typeof m !== "object") return false;
  if (m.Type !== "volume") return false;
  if (m.Target !== vol.target) return false;
  if (m.Source !== vol.name(expectAgent.prefix, expectAgent.agent)) return false;
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
    // Never the computer's secrets: every docker exec inherits Env (see bootTar below).
    Env: { required: true, is: v => Array.isArray(v) && v.every(e => isStr(e) && /^[A-Z_][A-Z0-9_]*=/.test(e) && !/^(COMPUTERD_TOKEN|VNC_PASSWORD)=/.test(e)) },
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

// ---- the computer's secrets, as a file, never as Env -----------------------------------------
//
// COMPUTERD_TOKEN and VNC_PASSWORD never go in a container's Env: Docker hands a container's Env
// to every `docker exec` in it, and the agent's uid can read an exec'd process's environment.
// Before each start, vyred copies one file into the computer's own volume instead, through the
// Engine's archive API: /var/lib/vyre/.boot, mode 0400, owned by vyre (1001). The entrypoint
// (root, but with no DAC_OVERRIDE) cannot read it; vyre's processes do (vncpasswd, computerd).
// The proxy lets that one upload through and nothing else: allowBootTar() checks every byte.

/** Where the file goes, what it is called, and who owns it. */
export const BOOT = Object.freeze({ dir: "/var/lib/vyre", name: ".boot", uid: 1001, gid: 1001, mode: 0o400 });
const BOOT_BODY = /^COMPUTERD_TOKEN=[A-Za-z0-9_-]{32,128}\nVNC_PASSWORD=[A-Za-z0-9_-]{6,8}\n$/;

/** @param {Buffer} h one 512-byte header @param {number} off @param {number} len @param {number} n */
const octal = (h, off, len, n) => h.write(n.toString(8).padStart(len - 1, "0") + "\0", off, len, "ascii");

/**
 * The tar holding .boot. VNC passwords are 8 characters at most (RFB DES), which pool.js's are.
 * @param {{ computerd_token: string, vnc_password: string }} s
 * @returns {Buffer}
 */
export function bootTar(s) {
  const body = Buffer.from(`COMPUTERD_TOKEN=${s.computerd_token}\nVNC_PASSWORD=${s.vnc_password}\n`, "ascii");
  if (!BOOT_BODY.test(body.toString("ascii"))) throw new Error("the computer's secrets are not in the expected shape");
  const h = Buffer.alloc(512);
  h.write(BOOT.name, 0, 100, "ascii");
  octal(h, 100, 8, BOOT.mode);
  octal(h, 108, 8, BOOT.uid);
  octal(h, 116, 8, BOOT.gid);
  octal(h, 124, 12, body.length);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h.write("0", 156, 1, "ascii");
  h.write("ustar\u000000", 257, 8, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad, Buffer.alloc(1024)]);
}

/**
 * Is this exactly a .boot tar as bootTar() makes it: one regular file, that name, owner and mode,
 * the expected contents, nothing after it but the end blocks? The archive PUT is the one way into a
 * computer's volume, so anything else is refused.
 * @param {Buffer} buf @returns {{ ok: true } | { ok: false, why: string }}
 */
export function allowBootTar(buf) {
  const no = why => ({ ok: /** @type {false} */ (false), why });
  if (!Buffer.isBuffer(buf) || buf.length < 1536 || buf.length > 4096 || buf.length % 512) return no("not a one-file tar of the expected size");
  const h = buf.subarray(0, 512);
  const str = (off, len) => h.subarray(off, off + len).toString("ascii").replace(/\0.*$/s, "");
  const num = (off, len) => parseInt(str(off, len).trim() || "x", 8);
  if (str(0, 100) !== BOOT.name || str(345, 155) !== "") return no(`the file must be ${BOOT.name}`);
  if (str(156, 1) !== "0") return no("the entry must be a regular file");
  if (num(100, 8) !== BOOT.mode || num(108, 8) !== BOOT.uid || num(116, 8) !== BOOT.gid) return no("wrong owner or mode");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (num(148, 8) !== sum) return no("bad header checksum");
  const size = num(124, 12);
  if (!(size > 0 && size < 512)) return no("wrong size");
  const body = buf.subarray(512, 512 + size).toString("ascii");
  if (!BOOT_BODY.test(body)) return no("the contents are not a computer's secrets");
  for (let i = 512 + size; i < buf.length; i++) if (buf[i] !== 0) return no("anything after .boot must be the end blocks");
  if (buf.length !== 512 + 512 + 1024) return no("not a one-file tar");
  return { ok: true };
}
