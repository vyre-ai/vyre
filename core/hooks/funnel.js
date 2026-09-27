// @ts-check
// funnel: what Tailscale Funnel is publishing, read from `tailscale funnel status --json`, and
// the commands the person runs to change it. Vyre never runs `tailscale funnel` with anything but
// `status --json` (ADR 0014): publishing a port to the internet is the person's own act.
//
// Funnel uses HTTPS port 8443, never 443: on the box vyred binds 443 on the tailnet addresses
// itself (ADR 0002), and a Funnel on 443 would take that port's traffic away from it. Funnel
// terminates TLS in tailscaled and proxies each path to vyred's hooks listener on 127.0.0.1,
// which tailscaled reaches because the box's two containers share one network namespace.

/** The Funnel port Vyre tells the person to use. Funnel allows 443, 8443 and 10000. */
export const FUNNEL_PORT = 8443;

/** @param {string} name @param {number} port the hooks listener's port */
export const openCommand = (name, port) =>
  `tailscale funnel --bg --https=${FUNNEL_PORT} --set-path=/hooks/${name} http://127.0.0.1:${port}/hooks/${name}`;
/** @param {string} name */
export const closeCommand = name => `tailscale funnel --https=${FUNNEL_PORT} --set-path=/hooks/${name} off`;
/** Turns off everything served on the Funnel port, for when the last route has closed. */
export const offCommand = () => `tailscale funnel --https=${FUNNEL_PORT} off`;
/** On a Docker box the CLI runs in the tailscale container. */
export const dockerPrefix = "cd /srv/vyre && docker compose exec tailscale ";

/**
 * @typedef {{ host: string, port: number, path: string, kind: "proxy"|"path"|"text"|"tcp",
 *   target: string|null, funnel: boolean }} Served
 */

/**
 * Pure: every handler in a serve config (`tailscale funnel status --json` prints the whole one),
 * with whether Funnel publishes it. Foreground sessions (a `tailscale funnel` left running in a
 * terminal) count the same as background ones.
 * @param {any} cfg
 * @returns {Served[]}
 */
export function parseFunnel(cfg) {
  /** @type {Served[]} */
  const out = [];
  const walk = (c) => {
    if (!c || typeof c !== "object") return;
    const allow = c.AllowFunnel && typeof c.AllowFunnel === "object" ? c.AllowFunnel : {};
    for (const [hostPort, web] of Object.entries(c.Web && typeof c.Web === "object" ? c.Web : {})) {
      const i = hostPort.lastIndexOf(":");
      const host = i > 0 ? hostPort.slice(0, i) : hostPort, port = i > 0 ? Number(hostPort.slice(i + 1)) : 443;
      for (const [p, h] of Object.entries(web && web.Handlers && typeof web.Handlers === "object" ? web.Handlers : {})) {
        const kind = h && h.Proxy ? "proxy" : h && h.Path ? "path" : "text";
        out.push({ host, port, path: p, kind, target: h && (h.Proxy || h.Path) ? String(h.Proxy || h.Path) : null, funnel: allow[hostPort] === true });
      }
    }
    // A raw TCP forward on a port Funnel allows is published too; it is never Vyre's.
    for (const [port, t] of Object.entries(c.TCP && typeof c.TCP === "object" ? c.TCP : {})) {
      if (!t || !t.TCPForward) continue;
      const funnel = Object.entries(allow).some(([hp, on]) => on === true && hp.endsWith(`:${port}`));
      out.push({ host: "", port: Number(port), path: "", kind: "tcp", target: String(t.TCPForward), funnel });
    }
    for (const f of Object.values(c.Foreground && typeof c.Foreground === "object" ? c.Foreground : {})) walk(f);
  };
  walk(cfg);
  return out;
}

/**
 * Pure: what the node's own status says about Funnel. Tailscale puts node attributes in
 * Self.CapMap: "funnel" when the policy grants it, "https" when HTTPS certificates are on, and
 * "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000" when the ports are limited.
 * @param {any} status `tailscale status --json`
 */
export function funnelNode(status) {
  const self = status && status.Self;
  const caps = self && self.CapMap && typeof self.CapMap === "object" ? Object.keys(self.CapMap) : [];
  const portsCap = caps.find(k => k.startsWith("https://tailscale.com/cap/funnel-ports?ports="));
  const ports = portsCap ? portsCap.split("ports=")[1].split(",").map(Number).filter(Number.isFinite) : null;
  return {
    dnsName: self && typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null,
    funnel: caps.includes("funnel"),
    https: caps.includes("https"),
    ports,
  };
}

/**
 * Pure: compare Vyre's open routes with what Funnel publishes.
 *   route-not-served     a route open in Vyre that no Funnel path reaches: its sender gets nowhere.
 *   wrong-target         Funnel publishes /hooks/<name> but forwards it somewhere else.
 *   funnel-without-route Funnel forwards a /hooks/ path Vyre has no route for. Harmless: vyred
 *                        answers 404 there. Usually a route closed in Vyre whose Funnel path was
 *                        left on.
 *   funnel-on-443        anything published on 443, which would take vyred's own port.
 *   funnel-other         something else published to the internet from this node, not by Vyre.
 * @param {string[]} routes open route names
 * @param {Served[]} served
 * @param {{ port: number, enabled: boolean }} hooks
 */
export function mismatches(routes, served, { port, enabled }) {
  const out = [];
  const pub = served.filter(s => s.funnel);
  for (const name of routes) {
    const at = pub.filter(s => s.path === `/hooks/${name}`);
    const want = `http://127.0.0.1:${port}/hooks/${name}`;
    if (!at.length) out.push({ kind: "route-not-served", route: name, harmless: false, message: `${name} is open in Vyre but Funnel does not publish /hooks/${name}, so no delivery can arrive`, fix: openCommand(name, port) });
    else if (!at.some(s => s.port === FUNNEL_PORT && s.kind === "proxy" && trimSlash(s.target) === want)) {
      out.push({ kind: "wrong-target", route: name, harmless: false, message: `Funnel publishes /hooks/${name} but forwards it to ${at.map(s => `${s.target || s.kind} on ${s.port}`).join(", ")}, not ${want} on ${FUNNEL_PORT}`, fix: `${closeCommand(name)} && ${openCommand(name, port)}` });
    }
  }
  for (const s of pub) {
    if (s.port === 443) out.push({ kind: "funnel-on-443", harmless: false, message: `Funnel publishes ${s.path || "a TCP forward"} on 443, the port vyred binds on the tailnet; use ${FUNNEL_PORT}`, fix: `tailscale funnel --https=443 off` });
    const m = /^\/hooks\/([^/]+)$/.exec(s.path);
    if (m && !routes.includes(m[1])) {
      out.push({ kind: "funnel-without-route", route: m[1], harmless: true, message: `Funnel still forwards /hooks/${m[1]}, which Vyre has no open route for; vyred answers 404 there, so nothing gets in, but the path stays public until it is turned off`, fix: closeCommand(m[1]) });
    } else if (!m && s.port !== 443) {
      out.push({ kind: "funnel-other", harmless: false, message: `Funnel also publishes ${s.kind === "tcp" ? `a raw TCP forward to ${s.target}` : `${s.path} (${s.target || s.kind})`} on ${s.port}, which is not a Vyre hook`, fix: null });
    }
  }
  if (!enabled && routes.some(n => pub.some(s => s.path === `/hooks/${n}`))) {
    out.push({ kind: "listener-off", harmless: true, message: "Funnel forwards Vyre's hook paths, but the hooks listener is off, so senders get an error until hooks.enable turns it on", fix: null });
  }
  return out;
}

const trimSlash = s => String(s || "").replace(/\/+$/, "");
