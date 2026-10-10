// @ts-check
// publicgate: the gate's public face (SPEC-wink-network 4.3; the user's ruling of 5 Oct 2026: Headscale is finished in 0.2.9).
//
// A second gate on a public port, TLS, for the box's name (<name>.vyre.run), in front of the same Headscale as the loopback gate. A device that is paired to this
// home joins directly, with no relay, once the name resolves to an address that reaches this port. It adds three things to the gate and reuses everything else:
//
//   certificate    lib/acme/acme.js (DNS-01 through the name directory, which holds the only vyre.run DNS credential) and lib/acme/certs.js (the store). The certificate
//                  key is made once and reused at every renewal, so the pin the pairing hands out (the SPKI) stays the same for the life of the box.
//   renewal        checked at start and then daily; a renewed certificate takes effect for the next handshake (gate.setTls).
//   the address    the name's A record is published (directory.publish: the public IPv4 the directory sees this box at) only once the port is known to answer from outside
//                  (core/wink/reach.js, `reachable()`), or when the person says so (config wink.publish). A name that points nowhere reachable would send every device
//                  to a dead address before the relay could carry it.
//
// Honest states, never a guess (`status().state`):
//   no-name      this box has no name yet: the gate stays loopback-only, nothing public is started, the relay carries everything
//   getting-cert the certificate is being issued
//   up           the TLS gate is listening and has a certificate
//   failed       it did not come up; `why` says why, the relay carries everything and it is retried
//
// Every outside thing is a dependency (directory, ACME issue, the gate, the clock), so a test runs it all against fakes and a real run uses a test CA.

import path from "node:path";
import * as certsReal from "../../../lib/acme/certs.js";
import * as acmeReal from "../../../lib/acme/acme.js";
import { createGate as realGate, certPin } from "./gate.js";
import { waitTxt } from "../../../lib/acme/dnswait.js";

const DAY = 86_400_000;

/**
 * @param {{
 *   name: () => string | null,                  the box's claimed name ("alex"), or null
 *   domain?: string,                            default vyre.run
 *   dir: string,                                where certificates live
 *   directory: { acme(name: string, token: string): Promise<any>, acmeClear(name: string): Promise<any>, publish(name: string, o?: { apps?: boolean, via?: string, share?: boolean }): Promise<any>,
 *     acmeOwn?(token: string): Promise<any>, acmeOwnClear?(): Promise<any>, hostAdd?(host: string): Promise<any>, hostRemove?(host: string): Promise<any> },
 *   hosts?: () => string[] | Promise<string[]>,  the person's own domains this box serves (sign.firm.com): each gets its own certificate by DNS-01 through the CNAME at _acme-challenge.<host>, and is listed with the directory
 *   upstream: { port: number },                 the Headscale the loopback gate already fronts
 *   listen?: { host?: string, port?: number },  default 0.0.0.0 and config port
 *   acme?: "production" | "staging" | string,   a name from acme.DIRECTORIES or a directory URL (a test CA)
 *   ingress?: { hooks: () => number | null | Promise<number | null>, share: () => number | null | Promise<number | null>, apps?: () => ({ port: number, hosts: string[] } | null) | Promise<{ port: number, hosts: string[] } | null> },   public webhooks, share links and app modules' own hosts (control/gate.js): the loopback ports to carry them to
 *   apps?: () => boolean | Promise<boolean>,    has this box an app module installed: the certificate then covers *.<name> too and the directory points *.<name> here (and stops when the last app is removed)
 *   onIngress?: (base: string | null) => void,   told the https origin links and webhooks use when it appears (the gate is up and the name points here) and null when it goes
 *   reachable?: () => boolean,                  has the outside check proved the port answers
 *   tunnel?: () => boolean,                     the box reaches the public through the Publish tunnel (no inbound port): publish the name via the tunnel, declaring its apps and share hosts
 *   publish?: boolean,                          publish the address without waiting for the outside check (the person's word: this box is directly on the internet)
 *   log?: (m: string) => void,
 *   now?: () => number,
 *   renewDays?: number,
 *   deps?: { createGate?: typeof realGate, certs?: typeof certsReal, acme?: typeof acmeReal, waitDns?: (fqdn: string, value: string) => Promise<any> },
 * }} o
 */
export function createPublicGate(o) {
  const log = o.log || (() => {});
  const D = { createGate: realGate, certs: certsReal, acme: acmeReal, waitDns: waitTxt, ...(o.deps || {}) };
  const domain = o.domain || "vyre.run";
  const now = o.now || Date.now;
  const renewDays = o.renewDays ?? 30;
  /** @type {{ state: "no-name" | "getting-cert" | "up" | "failed" | "stopped", why: string | null, since: number }} */
  const st = { state: "no-name", why: "this box has no name yet", since: now() };
  const set = (/** @type {typeof st.state} */ state, /** @type {string | null} */ why = null) => { st.state = state; st.why = why; st.since = now(); };
  /** @type {any} */ let gate = null, timer = null;
  /** @type {string | null} */ let fqdn = null, published = null;
  let expires = 0, stopped = false;
  /** @type {{ host: string, port: number } | null} */ let at = null;

  const acmeUrl = () => {
    const w = o.acme || "production";
    return /** @type {any} */ (D.acme.DIRECTORIES)[w] || (/^https?:\/\//.test(w) ? w : D.acme.DIRECTORIES.production);
  };
  const accountWhich = () => (o.acme === "staging" ? "staging" : "production");

  /** Does this box have an app module installed? Never throws. */
  const appsNow = async () => { try { return o.apps ? Boolean(await o.apps()) : false; } catch { return false; } };
  let wantApps = false, publishedApps = false, certApps = false;

  /** The certificate on disk if it is good for a while and covers the names, else a fresh one by DNS-01 through the directory, with the SAME key as before. With apps the names are [host, *.host] (one order, two challenges at the same label). @param {string} name @param {string} host @param {boolean} [withApps] */
  async function ensureCert(name, host, withApps = false) {
    const names = withApps ? [host, `*.${host}`] : [host];
    const have = D.certs.load(o.dir, host);
    if (have && !D.acme.needsRenewal(have.cert, now(), renewDays) && (!withApps || (D.acme.covers ? D.acme.covers(have.cert, names) : false))) return { ...have, renewed: false, apps: withApps };
    set("getting-cert");
    log(`wink net: getting a certificate for ${host}`);
    const r = await D.acme.issue({
      names, directory: acmeUrl(), accountKey: D.certs.accountKey(o.dir, accountWhich()),
      ...(have ? { certKey: have.key } : {}),
      dns: { set: async (/** @type {string} */ _f, /** @type {string} */ value) => { await o.directory.acme(name, value); return name; }, clear: async (/** @type {string} */ h) => { await o.directory.acmeClear(String(h)); } },
      ...(D.waitDns ? { waitDns: D.waitDns } : {}), log: m => log(`wink net: ${m}`),
    });
    D.certs.save(o.dir, host, { cert: r.cert, key: r.key });
    return { cert: r.cert, key: r.key, expires: r.expires, renewed: true, apps: withApps };
  }

  /** The own hosts and where each stands: "waiting" (the DNS record is not there yet), "getting-cert", "live", "failed". @type {Map<string, { state: string, why: string | null, expires?: number }>} */
  const hostSt = new Map();
  /** Hosts the directory has been told about this run (it answers a repeat at once). @type {Set<string>} */
  const listed = new Set();
  let hostTimer = /** @type {any} */ (null);

  /** The certificate of one own host: the one on disk if it is good for a while, else a fresh one by DNS-01 under this box's own-domain label (the CNAME at the host points there). @param {string} host */
  async function ensureHostCert(host) {
    const have = D.certs.load(o.dir, host);
    if (have && !D.acme.needsRenewal(have.cert, now(), renewDays)) return { ...have, renewed: false };
    log(`wink net: getting a certificate for ${host}`);
    const r = await D.acme.issue({
      names: [host], directory: acmeUrl(), accountKey: D.certs.accountKey(o.dir, accountWhich()),
      ...(have ? { certKey: have.key } : {}),
      dns: { set: async (/** @type {string} */ _f, /** @type {string} */ value) => { await /** @type {any} */ (o.directory).acmeOwn(value); return host; }, clear: async () => { await /** @type {any} */ (o.directory).acmeOwnClear(); } },
      ...(D.waitDns ? { waitDns: D.waitDns } : {}), log: m => log(`wink net: ${m}`),
    });
    D.certs.save(o.dir, host, { cert: r.cert, key: r.key });
    return { cert: r.cert, key: r.key, expires: r.expires, renewed: true };
  }

  /**
   * Bring the own hosts the person named in line: list each with the directory (which reads the CNAME proof live; no certificate is ordered before it holds), get its certificate, serve it by SNI.
   * A host that is no longer named is unlisted and its certificate dropped from the gate. One host's trouble never stops the others, and a waiting one is looked at again in five minutes. Never throws.
   */
  async function syncHosts() {
    if (!gate || !o.hosts || !o.directory.hostAdd) return;
    /** @type {string[]} */ let want = [];
    try { want = (await o.hosts()).map(h => String(h).toLowerCase()); } catch { return; }
    for (const host of want) {
      if (stopped || !gate) return;
      try {
        if (!listed.has(host)) { hostSt.set(host, { state: "waiting", why: "the directory is checking the DNS record" }); await o.directory.hostAdd(host); listed.add(host); }
        hostSt.set(host, { state: "getting-cert", why: null });
        const c = await ensureHostCert(host);
        gate.setHostTls(host, { cert: c.cert, key: c.key });
        hostSt.set(host, { state: "live", why: null, ...(c.expires ? { expires: c.expires } : {}) });
      } catch (e) {
        const code = String(/** @type {any} */ (e).code || "");
        hostSt.set(host, { state: code === "not_proven" ? "waiting" : "failed", why: String((e && /** @type {Error} */ (e).message) || e).slice(0, 300) });
        log(`wink net: own host ${host}: ${hostSt.get(host)?.why}`);
      }
    }
    for (const host of [...hostSt.keys()]) {
      if (want.includes(host) || !gate) continue;
      gate.dropHostTls(host);
      hostSt.delete(host);
      if (listed.delete(host) && o.directory.hostRemove) await o.directory.hostRemove(host).catch(() => {});
    }
    if (hostTimer) clearTimeout(hostTimer);
    hostTimer = null;
    if (!stopped && [...hostSt.values()].some(x => x.state !== "live")) { hostTimer = setTimeout(() => { syncHosts().catch(() => {}); }, 300_000); hostTimer.unref && hostTimer.unref(); }
  }

  /** Publish the name's address when the port is known to answer from outside (or the person said so). Never throws. */
  async function publishIfReady() {
    const name = o.name();
    if (!name || !gate || (published === name && publishedApps === wantApps)) return;
    const viaTunnel = Boolean(o.tunnel && o.tunnel());
    if (!(viaTunnel || o.publish === true || (o.reachable && o.reachable()))) return;
    // The wildcard goes into DNS only once the certificate that covers it is in hand: a name that resolves before it can be served would show a certificate error.
    const withApps = wantApps && certApps;
    try { await (viaTunnel ? o.directory.publish(name, { ...(withApps ? { apps: true } : {}), via: "tunnel", share: true }) : withApps ? o.directory.publish(name, { apps: true }) : o.directory.publish(name)); published = name; publishedApps = withApps; log(`wink net: ${name}.${domain} points at this box${withApps ? ", and so do its apps" : ""}`); told(); }
    catch (e) { log(`wink net: could not publish the address: ${/** @type {Error} */ (e).message}`); }
  }

  /** Tell the owner of the public links the origin they use, once, whenever it changes. */
  let toldBase = /** @type {string | null} */ (null);
  const told = () => {
    const b = o.ingress && gate && fqdn && at && published ? `https://${fqdn}:${at.port}` : null;
    if (b === toldBase) return;
    toldBase = b;
    try { if (o.onIngress) o.onIngress(b); } catch { /* a listener never breaks the gate */ }
  };

  async function start() {
    if (stopped) return status();
    const name = o.name();
    if (!name) { set("no-name", "this box has no name yet"); return status(); }
    fqdn = `${name}.${domain}`;
    try {
      wantApps = await appsNow();
      const c = await ensureCert(name, fqdn, wantApps);
      expires = c.expires; certApps = Boolean(c.apps);
      if (!gate) {
        gate = D.createGate({ listen: { host: (o.listen && o.listen.host) || "0.0.0.0", port: (o.listen && o.listen.port) || 0 }, tls: { cert: c.cert, key: c.key }, upstream: { port: o.upstream.port }, ...(o.ingress ? { ingress: o.ingress.apps ? { ...o.ingress, appsSuffix: `.${fqdn}` } : o.ingress } : {}),
          onEvent: (/** @type {any} */ e) => { if (e && e.type !== "accept") log(`public gate: ${e.type}${e.addr ? " " + e.addr : ""}`); } });
        at = await gate.listen();
      } else if (c.renewed) gate.setTls({ cert: c.cert, key: c.key });
      set("up");
      await publishIfReady();
      await syncHosts();
    } catch (e) {
      set("failed", String((e && /** @type {Error} */ (e).message) || e).slice(0, 300));
      log(`wink net: public gate: ${st.why}`);
    }
    schedule();
    return status();
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // a failure is retried in 10 minutes, a good certificate is looked at daily (nothing recurs under a minute)
    timer = setTimeout(() => { start().catch(() => {}); }, st.state === "up" ? DAY : 600_000);
    timer.unref && timer.unref();
  }

  function status() {
    return {
      state: st.state, why: st.why, since: st.since,
      name: fqdn, port: at ? at.port : null, expires: expires || null,
      hosts: [...hostSt].map(([host, v]) => ({ host, ...v })),
      pin: gate && gate.pin ? gate.pin : null, published: Boolean(published), ingress: Boolean(o.ingress), apps: wantApps && certApps && publishedApps,
    };
  }

  return {
    start, status,
    /** The reach helper has a new answer: publish now if the port just proved reachable. */
    reachChanged() { return publishIfReady(); },
    /**
     * An app module was installed or the last one was removed. The first app gets a certificate that covers *.<name> and then the wildcard in DNS; the removal of the last takes the wildcard out of DNS
     * (the certificate keeps its names until its next renewal, which asks for [name] alone). Never throws.
     */
    async appsChanged() {
      const w = await appsNow();
      if (w === wantApps || stopped) return;
      if (w && gate) { await start().catch(() => {}); return; }
      wantApps = w;
      await publishIfReady();
    },
    /** The person added, changed or removed an own domain: look again now. */
    hostsChanged() { return syncHosts(); },
    /** The own hosts that are served now (a certificate held), for the signing link and the apps' front. */
    liveHosts() { return [...hostSt].filter(([, v]) => v.state === "live").map(([h]) => h); },
    /** The https origin public links and webhooks use (https://<name>.vyre.run:<port>), or null until the gate is up with a certificate AND the name points here. */
    ingressBase() { return o.ingress && gate && fqdn && at && published ? `https://${fqdn}:${at.port}` : null; },
    /** The address devices dial, or null while there is none (no name, no certificate yet). */
    controlUrl() { return gate && fqdn && at ? `https://${fqdn}:${at.port}` : null; },
    pin() { return gate && gate.pin ? gate.pin : null; },
    port() { return at ? at.port : null; },
    async stop() { stopped = true; if (timer) clearTimeout(timer); if (hostTimer) clearTimeout(hostTimer); set("stopped"); if (gate) { const g = gate; gate = null; await g.close(); } told(); },
  };
}

export { certPin };
