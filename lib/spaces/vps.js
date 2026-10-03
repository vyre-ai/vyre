// @ts-check
// lib/spaces/vps.js: a DigitalOcean driver for "On a new server". Every impure thing is injected (fetch, timers,
// sleep). The API token arrives per call and is never stored, logged or left in any error or event: every message
// goes through redact(). Every failure is plain words, and every wait has a hard cap.

export const INSTALL_COMMAND = "curl -fsSL vyre.run/i | sh";
export const PAIR_PROMPT = "Enter the code from your phone or computer:";
const API = "https://api.digitalocean.com/v2";
const HARD_MAX_POLLS = 120;
const MAX_RATE_RETRIES = 2;

/** Monthly USD for the sizes the one-click offers. Estimates, not a quote. */
export const SIZES = Object.freeze({
  "s-1vcpu-2gb": 12, "s-2vcpu-2gb": 18, "s-2vcpu-4gb": 24, "s-4vcpu-8gb": 48,
});
export const REGIONS = Object.freeze(["nyc1", "nyc3", "sfo3", "tor1", "lon1", "fra1", "ams3", "sgp1", "blr1", "syd1"]);
export const DEFAULT_SIZE = "s-2vcpu-4gb";
export const DEFAULT_REGION = "nyc3";

export class VpsError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, retryable?: boolean }} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "VpsError";
    this.code = code;
    this.status = extra.status;
    this.retryable = extra.retryable === true;
  }
}

/**
 * Remove the token and anything shaped like one from a text.
 * @param {unknown} text @param {string[]} [secrets]
 */
export function redact(text, secrets = []) {
  let s = String(text ?? "");
  for (const x of secrets) if (x && x.length >= 4) s = s.split(x).join("[redacted]");
  return s.replace(/dop_v1_[A-Za-z0-9]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

/**
 * @param {string} size @param {string} region
 */
export function estimateMonthly(size = DEFAULT_SIZE, region = DEFAULT_REGION) {
  const usd = /** @type {Record<string, number>} */ (SIZES)[size];
  if (usd === undefined) throw new VpsError("bad_size", `That server size is not offered. Pick one of: ${Object.keys(SIZES).join(", ")}.`);
  if (!REGIONS.includes(region)) throw new VpsError("bad_region", `That region is not offered. Pick one of: ${REGIONS.join(", ")}.`);
  return { size, region, usdPerMonth: usd, note: "An estimate from the list price. DigitalOcean bills the account you connect, not Vyre." };
}

/**
 * The first-boot script. It holds no secret: the pairing code is typed by the person, not baked in.
 * @param {{ spaceId: string, installCommand?: string }} o
 */
export function cloudInit(o) {
  const cmd = o.installCommand ?? INSTALL_COMMAND;
  return [
    "#cloud-config",
    "package_update: true",
    "write_files:",
    "  - path: /etc/vyre-space",
    "    permissions: '0644'",
    `    content: ${o.spaceId}`,
    "runcmd:",
    `  - [ sh, -c, "${cmd}" ]`,
    `  - [ sh, -c, "echo '${PAIR_PROMPT}' | tee /etc/motd /dev/console" ]`,
    "",
  ].join("\n");
}

/**
 * Only what a home needs: HTTPS for the relay, WireGuard's UDP port for direct paths, SSH only when asked for.
 * @param {{ tag: string, allowSsh?: boolean }} o
 */
export function firewallRules(o) {
  const all = { addresses: ["0.0.0.0/0", "::/0"] };
  /** @type {any[]} */
  const inbound = [
    { protocol: "tcp", ports: "443", sources: all },
    { protocol: "udp", ports: "41641", sources: all },
  ];
  if (o.allowSsh) inbound.push({ protocol: "tcp", ports: "22", sources: all });
  return {
    name: `${o.tag}-fw`.slice(0, 63),
    inbound_rules: inbound,
    outbound_rules: [
      { protocol: "tcp", ports: "all", destinations: all },
      { protocol: "udp", ports: "all", destinations: all },
      { protocol: "icmp", destinations: all },
    ],
    tags: [o.tag],
  };
}

/**
 * @typedef {{ fetch: (url: string, init: any) => Promise<any>,
 *   sleep?: (ms: number) => Promise<void>,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 *   timeoutMs?: number, emit?: (type: string, payload: any) => void }} VpsDeps
 */

const plainStatus = (/** @type {number} */ status) => {
  if (status === 401) return ["bad_token", "DigitalOcean did not accept the token. Make a token with read and write access and try again."];
  if (status === 403) return ["forbidden", "DigitalOcean says this token may not do that. Check the token's access and the account's limits."];
  if (status === 404) return ["not_found", "DigitalOcean could not find that server. It may already be gone."];
  if (status === 422) return ["rejected", "DigitalOcean rejected the request. Check the region and size, and that the account can add a server."];
  if (status === 429) return ["rate_limited", "DigitalOcean is asking us to slow down. Wait a minute and try again."];
  if (status >= 500) return ["provider_down", "DigitalOcean had a problem on its side. Try again in a few minutes."];
  return ["failed", `DigitalOcean answered with an unexpected status (${status}).`];
};

/**
 * One API call. 429 is retried a limited number of times, honouring Retry-After.
 * @param {string} token @param {string} method @param {string} path @param {any} body @param {VpsDeps} deps
 */
async function call(token, method, path, body, deps) {
  if (typeof token !== "string" || token.length < 8) throw new VpsError("no_token", "Paste your DigitalOcean token to continue.");
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const setTimer = deps.setTimer ?? setTimeout, clearTimer = deps.clearTimer ?? clearTimeout;
  const timeoutMs = deps.timeoutMs ?? 20000;
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimer(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await deps.fetch(API + path, {
        method, signal: ac.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const aborted = ac.signal.aborted || /** @type {any} */ (e)?.name === "AbortError";
      throw new VpsError(aborted ? "timeout" : "unreachable", aborted ? "DigitalOcean took too long to answer. Try again." : "Could not reach DigitalOcean. Check the internet connection and try again.", { retryable: true });
    } finally { clearTimer(timer); }
    if (res.status === 429 && attempt < MAX_RATE_RETRIES) {
      const ra = Number(res.headers?.get?.("retry-after"));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * (attempt + 1), 30000));
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204) return {};
      try { return typeof res.json === "function" ? await res.json() : JSON.parse(await res.text()); } catch { return {}; }
    }
    const [code, message] = plainStatus(res.status);
    throw new VpsError(code, message, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  }
}

/** Never let a token reach the caller, whatever was thrown. */
const guard = async (/** @type {string} */ token, /** @type {() => Promise<any>} */ fn) => {
  try { return await fn(); } catch (e) {
    if (e instanceof VpsError) { e.message = redact(e.message, [token]); throw e; }
    throw new VpsError("failed", redact("Something went wrong talking to DigitalOcean. Try again.", [token]));
  }
};

/**
 * Make the firewall, then the server inside it. If the server cannot be made, the firewall is removed again.
 * @param {{ token: string, spaceId: string, name?: string, region?: string, size?: string, allowSsh?: boolean }} o
 * @param {VpsDeps} deps
 */
export function createDroplet(o, deps) {
  return guard(o.token, async () => {
    const region = o.region ?? DEFAULT_REGION, size = o.size ?? DEFAULT_SIZE;
    estimateMonthly(size, region);
    const tag = `vyre-${o.spaceId}`.replace(/_/g, "-");
    const fw = await call(o.token, "POST", "/firewalls", firewallRules({ tag, allowSsh: o.allowSsh }), deps);
    const firewallId = fw?.firewall?.id;
    if (!firewallId) throw new VpsError("failed", "DigitalOcean did not make the firewall. Try again.");
    try {
      const d = await call(o.token, "POST", "/droplets", {
        name: (o.name ?? tag).replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 60), region, size, image: "ubuntu-24-04-x64",
        user_data: cloudInit({ spaceId: o.spaceId }), tags: [tag], monitoring: true, ipv6: false,
      }, deps);
      const dropletId = d?.droplet?.id;
      if (!dropletId) throw new VpsError("failed", "DigitalOcean did not make the server. Try again.");
      deps.emit?.("space.vps.created", { spaceId: o.spaceId, provider: "digitalocean", region, size });
      return { dropletId: String(dropletId), firewallId: String(firewallId), tag, region, size };
    } catch (e) {
      await call(o.token, "DELETE", `/firewalls/${firewallId}`, undefined, deps).catch(() => {});
      throw e;
    }
  });
}

/**
 * Poll until the server is active. Hard cap on polls; one poll that fails is a failure, not a retry loop.
 * @param {string} token @param {string} dropletId @param {VpsDeps} deps
 * @param {{ intervalMs?: number, maxPolls?: number }} [opts]
 */
export function waitActive(token, dropletId, deps, opts = {}) {
  return guard(token, async () => {
    const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    const max = Math.min(opts.maxPolls ?? 60, HARD_MAX_POLLS), interval = Math.max(opts.intervalMs ?? 5000, 1000);
    for (let i = 0; i < max; i++) {
      const r = await call(token, "GET", `/droplets/${encodeURIComponent(dropletId)}`, undefined, deps);
      const d = r?.droplet;
      if (d?.status === "active") {
        const v4 = (d.networks?.v4 ?? []).find((/** @type {any} */ n) => n.type === "public");
        return { dropletId: String(dropletId), address: v4?.ip_address ?? null };
      }
      if (d?.status === "archive" || d?.status === "off") throw new VpsError("not_active", "The server stopped before it finished starting. Remove it and try again.");
      if (i < max - 1) await sleep(interval);
    }
    throw new VpsError("slow_start", "The server is taking too long to start. Remove it and try again, or pick another region.", { retryable: true });
  });
}

/**
 * Remove the server and its firewall. Already gone counts as removed. Says which part failed.
 * @param {string} token @param {{ dropletId?: string, firewallId?: string }} ids @param {VpsDeps} deps
 */
export function destroy(token, ids, deps) {
  return guard(token, async () => {
    /** @type {string[]} */ const removed = [];
    /** @type {{ what: string, why: string }[]} */ const failed = [];
    for (const [what, path] of /** @type {[string, string | null][]} */ ([
      ["server", ids.dropletId ? `/droplets/${encodeURIComponent(ids.dropletId)}` : null],
      ["firewall", ids.firewallId ? `/firewalls/${encodeURIComponent(ids.firewallId)}` : null],
    ])) {
      if (!path) continue;
      try { await call(token, "DELETE", path, undefined, deps); removed.push(what); } catch (e) {
        if (e instanceof VpsError && e.code === "not_found") removed.push(what);
        else failed.push({ what, why: redact(/** @type {any} */ (e)?.message ?? "It could not be removed.", [token]) });
      }
    }
    if (failed.length) {
      const err = new VpsError("destroy_failed", `Could not remove the ${failed.map(f => f.what).join(" and ")}: ${failed[0].why} Remove it in your DigitalOcean account so it stops costing money.`);
      /** @type {any} */ (err).removed = removed; /** @type {any} */ (err).failed = failed;
      throw err;
    }
    deps.emit?.("space.vps.destroyed", { removed });
    return { removed };
  });
}
