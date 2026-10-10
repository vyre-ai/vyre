// @ts-check
// The host-helper driver of an app module: the second driver behind the interface runtime.js describes (up, exec, status, stop, down, logs). On a server vyred runs in a container with no Docker;
// the root helper on the host (box/vyre `space-helper`, team/0.3/DESIGN-appmods-helper.md) starts the app from the catalog line root recorded out of the vyre image, walls it off, and runs the
// app's one-time setup itself. This side only asks: `app-up|app-stop|app-down <module>`, through the same spool and status folders as Twenty's (stores/twenty/helper.js). Nothing here names
// an image, a flag, a path, a port or a key; the keys and the setup's outputs come back once in a file only this uid can read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askHelper, helperPresent, STATE_DIR } from "../../stores/twenty/helper.js";

/** The subnets the helper walled for an app (status/subnets, `app:<module> <subnet>`). @param {string} state @param {string} module */
export function subnetsOf(state, module) {
  try {
    return fs.readFileSync(path.join(state, "subnets"), "utf8").split("\n").map(l => l.trim().split(" ")).filter(x => x[0] === `app:${module}` && x[1]).map(x => x[1]);
  } catch { return []; }
}

/** Is the IPv4 address inside the subnet (a.b.c.d/n)? @param {string} ip @param {string} cidr */
export function inSubnet(ip, cidr) {
  const num = (/** @type {string} */ a) => a.split(".").reduce((n, x) => n * 256 + Number(x), 0);
  const [base, bits] = cidr.split("/");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base || "") || !(Number(bits) >= 0 && Number(bits) <= 32)) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(num(ip) / size) === Math.floor(num(base) / size);
}

/** The setup's hand-over: `name=value` lines in status/app-<module>-secrets, or null when there is none (an app that was set up before). @param {string} state @param {string} module */
export function readHandoff(state, module) {
  let text = "";
  try { text = fs.readFileSync(path.join(state, `app-${module}-secrets`), "utf8"); } catch { return null; }
  /** @type {Record<string, string>} */ const out = {};
  for (const l of text.split("\n")) { const m = /^([a-z][a-z0-9_]*)=([A-Za-z0-9_.@+=/:-]{1,300})$/.exec(l); if (m) out[m[1]] = m[2]; }
  return Object.keys(out).length ? out : null;
}

/** Is this server one with a host helper? The same check as Twenty's. */
export const hostHelperHere = helperPresent;

/**
 * @param {{ spool?: string, state?: string, log?: (m: string) => void, interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, pollMs?: number, timeoutMs?: number }} [o]
 */
export function createHelperDriver(o = {}) {
  const state = o.state ?? STATE_DIR;
  const log = o.log ?? (() => {});
  const ask = (/** @type {"app-up" | "app-stop" | "app-down"} */ verb, /** @type {string} */ name) =>
    askHelper(verb, name, { spool: o.spool, state, log, what: "this app", sleep: o.sleep, pollMs: o.pollMs, timeoutMs: o.timeoutMs ?? 30 * 60_000 });
  const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
  return {
    kind: "helper",

    /** The hook port is fixed in the catalog (root checks it is unique and free). @param {any} manifest */
    hookPortFor(manifest) {
      const p = manifest && manifest.app && manifest.app.hookPort;
      if (!Number.isInteger(p)) throw refuse(`${manifest && manifest.name} does not run on a server with a host helper: its manifest has no hook port; ask the owner of this server`, "unsupported");
      return /** @type {number} */ (p);
    },

    /**
     * Ask for the app to be up. `outputs` holds what root's one-time setup made (hook_token and the manifest's bootstrap outputs) on the first start, and is null on every later one.
     * @param {{ space: string, manifest: any }} p
     * @returns {Promise<{ origin: string, hookHost: string, outputs: Record<string, string> | null }>}
     */
    async up(p) {
      const name = p.manifest.name;
      await ask("app-up", name);
      const subs = subnetsOf(state, name);
      const nets = (o.interfaces ?? os.networkInterfaces)();
      let hookHost = "";
      for (const list of Object.values(nets)) for (const a of list || []) if (a.family === "IPv4" && subs.some(s => inSubnet(a.address, s))) hookHost = a.address;
      if (!hookHost) throw refuse(`this server's vyre container has no address on ${name}'s network`, "runtime");
      return { origin: `http://vyre-app-${name}:${p.manifest.app.port}`, hookHost, outputs: readHandoff(state, name) };
    },

    /** The setup runs on the host, inside the first `up`. */
    async exec() { throw refuse("on this server the host runs the app's setup itself: use appmods.install, which sets it up", "unsupported"); },

    /** Healthy when its health path answers one of the manifest's codes; there is no host call for it. @param {{ manifest: any }} p @param {string} [origin] */
    async status(p, origin) {
      const a = p.manifest.app;
      const url = `http://vyre-app-${p.manifest.name}:${a.port}${a.health.path}`;
      try {
        const r = await (o.fetchImpl ?? fetch)(origin || url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
        return { state: a.health.ok.includes(r.status) ? "running" : "stopped", detail: String(r.status) };
      } catch { return { state: "stopped", detail: "no answer" }; }
    },

    /** @param {{ manifest: any }} p */
    async stop(p) { await ask("app-stop", p.manifest.name); },

    /** The data stays: deleting it is done on the server, not asked for. @param {{ manifest: any }} p @param {{ data?: boolean }} [opt] */
    async down(p, opt = {}) {
      if (opt.data) throw refuse("on this server the app's data is deleted from the server itself, not from here; remove the app without data, or ask the server's owner", "unsupported");
      await ask("app-down", p.manifest.name);
    },

    /** @param {{ manifest: any }} p */
    async logs(p) { return `The app's logs are on the server: sudo docker logs vyre-app-${p.manifest.name}`; },
  };
}
