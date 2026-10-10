// The pure half of This computer: what runs here, history search, webhooks, the Wink network, agent computers and shares as lines (the Deck's settings.js sections, ported).
// A command a person must run themselves is shown to copy, never run: the box never runs it for them.

export type Card = { title: string; state?: string; lines: string[]; warn: string[]; actions: { id: "hooks-on" | "hooks-off" | "hooks-open" | "hooks-close"; label: string; arg?: string }[] };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const list = (v: unknown, key: string): any[] => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && (key === "" || typeof (x as any)[key] === "string"));
const card = (title: string, state?: string): Card => ({ title, state, lines: [], warn: [], actions: [] });

/** What runs here: host, role, version, platform. */
export function machineRows(s: any): [string, string][] {
  const role = s?.role === "box" ? "Always on. Runs your assistants and answers your devices." : s?.role === "local" ? "Your own computer. It connects to your home over your private network." : String(s?.role || "");
  return [["Host", String(s?.host || "")], ["Role", role], ["Vyre", String(s?.version || "")], ["Platform", String(s?.platform || "")], ["Node", String(s?.node || "")]].filter(([, v]) => v) as [string, string][];
}
/** The name this computer shows, which can be changed (system.rename). Empty when the box does not name itself. */
export const nameOf = (s: any): string | null => (typeof s?.serverName === "string" && s.serverName ? s.serverName : null);
/** Which web origins may reach this home from the owner's browser. Null when the box does not say. */
export function hostedLine(s: any): string | null {
  const o = s?.network?.origins;
  if (!Array.isArray(o)) return null;
  const hosts = o.map((x: unknown) => { try { return new URL(String(x)).host; } catch { return String(x); } });
  return o.length ? `The app at ${hosts.join(", ")} can reach your home from your browser after you sign in.` : "No hosted app can reach your home.";
}

const ago = (at: number, now: number) => { const m = Math.max(0, Math.round((now - at) / 60000)); return m < 1 ? "just now" : m < 60 ? `${plural(m, "minute")} ago` : m < 1440 ? `${plural(Math.round(m / 60), "hour")} ago` : `${plural(Math.round(m / 1440), "day")} ago`; };
/** History search: what is indexed and the last pass. */
export function recallView(s: any, now = Date.now()): { lines: [string, string][]; indexing: boolean; problem: string } {
  const last = s?.last;
  const v = s?.vectors || {};
  return {
    indexing: !!s?.indexing,
    problem: s?.error ? String(s.error) : "",
    lines: [
      ["Indexed", `${plural(s?.sessions || 0, "session")}, ${plural(s?.turns || 0, "turn")}`],
      ["Folders", Array.isArray(s?.folders) && s.folders.length ? s.folders.join(", ") : "None"],
      ["Last pass", last?.at ? `${ago(last.at, now)}: ${[last.added ? `${last.added} added` : "", last.appended ? `${last.appended} appended` : "", `${last.skipped || 0} unchanged`, last.failed ? `${last.failed} failed` : ""].filter(Boolean).join(", ")}` : "Not yet"],
      ["Search by meaning", v.on ? `On, ${v.embedded || 0} embedded, ${v.pending || 0} waiting` : `Off${v.why ? `. ${String(v.why).replace(/^./, (c) => c.toUpperCase())}.` : ""}`],
    ],
  };
}

/** Webhooks: off, or the open routes. */
export function hooksCard(d: any, status: any): Card {
  const c = card("Webhooks");
  const routes = list(d?.routes, "name");
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.push("A webhook lets a service such as a payment processor tell Vyre that something happened. It is the one part of Vyre open to the internet, so it stays off until you turn it on.");
    c.actions.push({ id: "hooks-on", label: "Turn on" });
    return c;
  }
  c.state = routes.length ? `On, ${plural(routes.length, "open route")}` : "On, no open routes";
  if (d.listening === false) c.warn.push(`The webhook listener is not answering${d.error ? ` (${d.error})` : ""}.`);
  for (const r of routes) {
    c.lines.push(`${r.path || `/hooks/${r.name}`} ${r.verify?.scheme || ""}${typeof r.deliveries === "number" ? `, ${plural(r.deliveries, "delivery", "deliveries")} kept` : ""}`.trim());
  }
  c.actions.push({ id: "hooks-open", label: "Open a route" });
  for (const r of routes) c.actions.push({ id: "hooks-close", label: `Close ${r.name}`, arg: String(r.name) });
  c.actions.push({ id: "hooks-off", label: "Turn off" });
  return c;
}

/** The Wink network: whether this computer is signed in, each space's link (state, the path it takes, how fast, how many devices) and the relay. Read only, from network.wink.status. */
export function winkCard(d: any): Card {
  const c = card("Wink network");
  const spaces = list(d?.spaces, "id");
  const bad = spaces.filter((x) => x.state !== "connected");
  c.state = !spaces.length ? "No spaces linked" : bad.length ? `${plural(bad.length, "space")} not connected` : "Connected";
  for (const x of spaces) {
    const via = x.path === "direct" ? "direct" : x.path === "relay" ? "through the relay" : "";
    c.lines.push([String(x.name || "A space"), String(x.state || "unknown"), via, typeof x.latencyMs === "number" ? `${Math.round(x.latencyMs)} ms` : "", typeof x.peers === "number" ? plural(x.peers, "device") : ""].filter(Boolean).join(", "));
  }
  if (d?.relay) c.lines.push(`Relay: ${d.relay.enabled === false ? "off" : d.relay.reachable === false ? "not reachable" : "reachable"}${typeof d.relay.latencyMs === "number" ? `, ${Math.round(d.relay.latencyMs)} ms` : ""}`);
  if (d?.otherVpn) c.warn.push("Another VPN is running on this computer. It can get in the way of the link to your devices.");
  if (typeof d?.clock?.skewMs === "number" && Math.abs(d.clock.skewMs) > 30_000) c.warn.push("This computer's clock is off by more than 30 seconds. Sign-in can fail until it is right.");
  return c;
}

/** Glass egress: listed sites leave an agent's browser through the owner's Mac. */
export function egressCard(d: any): Card {
  const c = card("Glass egress");
  const sites: unknown[] = Array.isArray(d?.sites) ? d.sites : [];
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.push("Some sites refuse a datacenter address. The sites you list leave an agent's browser through your own Mac instead.");
    return c;
  }
  c.state = sites.length ? `On, ${plural(sites.length, "site")}` : "On, no sites yet";
  if (sites.length) c.lines.push(sites.map(String).join(", "));
  const side = d.sidecar || {};
  if (side.answers) c.lines.push("The egress sidecar answers.");
  else c.warn.push(`The egress sidecar does not answer${side.why ? ` (${side.why})` : ""}. The listed sites fail until it does, rather than show your home's address.`);
  if (d.problem) c.warn.push(String(d.problem));
  if (d.applies) c.lines.push(`This ${d.applies}.`);
  return c;
}

/** Glass hand-back: after how long without input a take-over goes back to the agent. */
export function handbackOf(d: any): { minutes: number; choices: number[]; warn: number } {
  return { minutes: Number(d?.minutes) || 0, choices: Array.isArray(d?.choices) && d.choices.length ? d.choices.map(Number) : [0, 2, 5, 15], warn: Number(d?.warn_s) || 10 };
}
export const handbackLabel = (m: number) => (m ? `After ${m} min idle` : "Off");

/** VyreDrive shares and what each allows. */
export type Share = { name: string; shared?: boolean; mounted?: boolean; access?: string };
export function sharesOf(d: any): { enabled: boolean; why: string; shares: Share[] } {
  return { enabled: !!d?.enabled, why: [d?.why, d?.fix].filter(Boolean).join(" "), shares: list(d?.shares, "name") as Share[] };
}
export const accessWord = (a?: string) => (a === "rw" ? "Read and write" : "Read only");
export const flipAccess = (a?: string): "ro" | "rw" => (a === "rw" ? "ro" : "rw");
/** What the audit found: shares with secrets inside, and devices beyond the paired Macs that can reach them. */
export function auditLines(a: any): { ok: boolean; lines: string[] } {
  const lines: string[] = list(a?.unsafe, "share").map((u) => {
    const found: string[] = Array.isArray(u.found) ? u.found.map(String).filter(Boolean) : [];
    return u.why ? `${u.share} could not be checked for secrets: ${u.why}${found.length ? `. Found so far: ${found.join(", ")}` : ""}.` : `${u.share} has secrets inside: ${found.length ? found.join(", ") : "files that look like keys"}`;
  });
  const f = list(a?.findings, "");
  if (f.length) lines.push(`${plural(f.length, "device")} outside your paired Macs can reach these shares: ${f.map((x) => x.node || "a device").join(", ")}. Only your network policy decides this. Remove them in your network's access settings. Vyre does not change it.`);
  const ok = !lines.length;
  if (ok) lines.push(`Only your paired Macs can reach them.${a?.checked != null ? ` Checked ${plural(a.checked, "online device")}.` : ""}`);
  return { ok, lines };
}
