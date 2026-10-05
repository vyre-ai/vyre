// The pure half of This computer: what runs here, history search, webhooks, guests, agent computers, shares and Tailnet Lock as lines (the Deck's settings.js sections, ported).
// A command a person must run themselves is shown to copy, never run: the box never runs it for them.

export type Card = { title: string; state?: string; lines: string[]; warn: string[]; commands: { say: string; line: string }[] };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const list = (v: unknown, key: string): any[] => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && (key === "" || typeof (x as any)[key] === "string"));
const card = (title: string, state?: string): Card => ({ title, state, lines: [], warn: [], commands: [] });

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

/** Webhooks: off, or the open routes and where the public tunnel and Vyre disagree. */
export function hooksCard(d: any, status: any): Card {
  const c = card("Webhooks");
  const routes = list(d?.routes, "name");
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.push("A webhook lets a service such as a payment processor tell Vyre that something happened. It is the one part of Vyre open to the internet, so it stays off until you turn it on.");
    c.commands.push({ say: "Turn it on from your home computer's terminal:", line: "vyre hooks on" });
    return c;
  }
  c.state = routes.length ? `On, ${plural(routes.length, "open route")}` : "On, no open routes";
  if (d.listening === false) c.warn.push(`The webhook listener is not answering${d.error ? ` (${d.error})` : ""}.`);
  for (const r of routes) {
    c.lines.push(`${r.path || `/hooks/${r.name}`} ${r.verify?.scheme || ""}${typeof r.deliveries === "number" ? `, ${plural(r.deliveries, "delivery", "deliveries")} kept` : ""}`.trim());
    if (r.funnel?.open) c.commands.push({ say: `Publish ${r.name} with Funnel:`, line: String(r.funnel.open) });
    if (r.funnel?.close) c.commands.push({ say: `Stop publishing ${r.name}:`, line: String(r.funnel.close) });
  }
  for (const m of list(status?.mismatches, "message")) {
    c.warn.push(m.harmless ? `${m.message}. Harmless.` : `Funnel and Vyre disagree: ${m.message}.`);
    if (m.fix) c.commands.push({ say: "To fix it:", line: String(m.fix) });
  }
  c.lines.push("Vyre never runs tailscale funnel. Run these yourself, on your home computer.");
  c.commands.push({ say: "Open a route:", line: "vyre hooks open <name> --scheme hmac-sha256 --header <header> --secret <vault item>" });
  if (routes.length) c.commands.push({ say: "Close one:", line: `vyre hooks close ${routes[0].name}` });
  c.commands.push({ say: "Turn webhooks off:", line: "vyre hooks off" });
  return c;
}

/** Guests: people on another private network this home is shared with, and the tools each may call. */
export function guestsCard(d: any): Card {
  const c = card("Guests");
  const people = list(d?.people, "login");
  const safe: string[] = Array.isArray(d?.safe) ? d.safe : [];
  if (safe.length) c.lines.push(`A guest can only ever call these: ${safe.join(", ")}.`);
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.unshift("A guest is someone on another tailnet you shared your home with. They may call only the tools you list for them, and never act as you.");
    c.commands.push({ say: "Turn guests on from your home computer's terminal:", line: `vyre call --tty network.guests.enable '{"on":true}'` });
    return c;
  }
  c.state = people.length ? `On, ${plural(people.length, "person", "people")}` : "On, no one yet";
  for (const p of people) {
    const allowed: string[] = Array.isArray(p.allowed) ? p.allowed : Array.isArray(p.tools) ? p.tools : [];
    const asked: string[] = Array.isArray(p.tools) ? p.tools.filter((t: string) => !allowed.includes(t)) : [];
    c.lines.push(`${p.login}: ${allowed.join(", ") || "no tools"}`);
    if (asked.length) c.warn.push(`Listed for ${p.login} but not guest-safe, so refused: ${asked.join(", ")}.`);
  }
  c.commands.push({ say: "Add someone:", line: `vyre call --tty network.guests.add '{"login":"<login>","tools":["threads.list"]}'` });
  if (people.length) c.commands.push({ say: "Remove them:", line: `vyre call --tty network.guests.remove '{"login":"${people[0].login}"}'` });
  c.commands.push({ say: "Turn guests off:", line: `vyre call --tty network.guests.enable '{"on":false}'` });
  return c;
}

/** Agent nodes: whether each agent's computer joins the private network as its own tagged node. */
export function tailnetCard(d: any): Card {
  const c = card("Agent nodes");
  const tag = d?.tag || "tag:vyre-agent";
  const v = d?.vault;
  if (d?.problem) c.warn.push(String(d.problem));
  if (v) c.lines.push(`Auth key ${v.item || ""} in the Vault: ${v.exists == null ? "not known" : v.exists ? (v.granted ? "there, and granted" : "there, not granted yet") : "not there yet"}${v.why ? ` (${v.why})` : ""}.`);
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.unshift(`With this on, each agent's computer joins your private network as its own node, tagged ${tag}, so your network policy can tell agents apart.`);
    c.commands.push({ say: "Turn it on:", line: `vyre call --tty computers.tailnet.set '{"enabled":true}'` });
    return c;
  }
  c.state = "On";
  c.lines.unshift(`Tagged ${tag}.`);
  const comps = list(d?.computers, "");
  c.lines.push(comps.length ? comps.map((x) => `${x.agent || "an agent"}${x.node ? ` (${x.node})` : ""}, ${x.running ? "running" : "not running"}`).join("; ") : "No agent has a computer yet.");
  if (d.applies) c.lines.push(`This ${d.applies}.`);
  c.commands.push({ say: "Turn it off:", line: `vyre call --tty computers.tailnet.set '{"enabled":false}'` });
  return c;
}

/** Glass egress: listed sites leave an agent's browser through the owner's Mac. */
export function egressCard(d: any): Card {
  const c = card("Glass egress");
  const sites: unknown[] = Array.isArray(d?.sites) ? d.sites : [];
  if (!d?.enabled) {
    c.state = "Off";
    c.lines.push("Some sites refuse a datacenter address. The sites you list leave an agent's browser through your own Mac instead.");
    c.commands.push({ say: "Turn it on:", line: `vyre call --tty computers.egress.set '{"enabled":true,"sites":["example.com"]}'` });
    return c;
  }
  c.state = sites.length ? `On, ${plural(sites.length, "site")}` : "On, no sites yet";
  if (sites.length) c.lines.push(sites.map(String).join(", "));
  const side = d.sidecar || {};
  if (side.answers) c.lines.push("The egress sidecar answers.");
  else c.warn.push(`The egress sidecar does not answer${side.why ? ` (${side.why})` : ""}. The listed sites fail until it does, rather than show your home's address.`);
  if (d.problem) c.warn.push(String(d.problem));
  if (d.applies) c.lines.push(`This ${d.applies}.`);
  c.commands.push({ say: "Turn it off:", line: `vyre call --tty computers.egress.set '{"enabled":false}'` });
  return c;
}

/** Glass hand-back: after how long without input a take-over goes back to the agent. */
export function handbackOf(d: any): { minutes: number; choices: number[]; warn: number } {
  return { minutes: Number(d?.minutes) || 0, choices: Array.isArray(d?.choices) && d.choices.length ? d.choices.map(Number) : [0, 2, 5, 15], warn: Number(d?.warn_s) || 10 };
}
export const handbackLabel = (m: number) => (m ? `After ${m} min idle` : "Off");

/** Tailnet Lock: read only. On (and whether this home is signed), or what it is and the steps to turn it on from the Mac. */
export function lockCard(d: any): Card {
  const c = card("Tailnet Lock");
  if (d?.enabled) {
    c.state = "On";
    const keys = d.trusted ? ` Your network trusts ${plural(Number(d.trusted), "signing key")}.` : "";
    c.lines.push(d.signed === true ? `Tailnet Lock is on, and your home is signed.${keys}` : d.signed === false ? `Tailnet Lock is on, but your home is not signed yet. Sign it from a device you trust, with tailscale lock sign or in the Tailscale admin console.${keys}` : `Tailnet Lock is on.${keys}`);
    return c;
  }
  c.state = "Off";
  c.lines.push("With Tailnet Lock, a new device must be signed by a device you trust before it can join your private network. So even someone who steals your Tailscale login cannot add a machine.");
  c.lines.push("The cost: every new device needs that signature first. If you lose every signing device and the disablement secrets too, you are locked out of changing it.");
  const cm = d?.commands || { mac: "tailscale lock", init: `tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> ${d?.key || "<home key>"}` };
  c.commands.push({ say: "On your Mac, read its key. It is the one that starts with tlpub:", line: String(cm.mac) });
  if (d?.key) c.commands.push({ say: "Your home's key:", line: String(d.key) });
  else c.warn.push(`Your home did not give its key${d?.why ? ` (${d.why})` : ""}. Check again once Tailscale is running here.`);
  c.commands.push({ say: "On your Mac, run this, with your Mac's key in place of <mac key>:", line: String(cm.init) });
  c.lines.push("It prints two disablement secrets. Save both in the Vault. Either one turns the lock off if every signing device is lost, and Tailscale support keeps one more. Vyre never runs these. Run them yourself, on your Mac.");
  return c;
}

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
  if (f.length) lines.push(`${plural(f.length, "device")} outside your paired Macs can reach these shares: ${f.map((x) => x.node || "a device").join(", ")}. Only your network policy decides this. Remove them in the Tailscale admin console, Access controls. Vyre does not change it.`);
  const ok = !lines.length;
  if (ok) lines.push(`Only your paired Macs can reach them.${a?.checked != null ? ` Checked ${plural(a.checked, "online device")}.` : ""}`);
  return { ok, lines };
}
