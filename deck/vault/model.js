// @ts-check
// What the Vault app reads from its tools, reduced to the named fields it draws, and its places.
// No DOM; node tests it. Nothing here ever holds a value: vault.list has none, and these pickers
// copy only the keys they name, so a stray field in a reply cannot reach the page.

export const KIND = { login: "Login", card: "Card", note: "Secure note", "api-key": "API key", "env-set": "Env set", "ssh-key": "SSH key", secret: "Secret" };

/** Places, in rail order. `kind` filters the list; `view` is a page of its own. */
export const PLACES = [
  { id: "all", label: "All items", short: "All", icon: "vault" },
  { id: "favorites", label: "Favorites", icon: "pin" },
  { id: "logins", label: "Logins", kind: "login", icon: "login", group: "kinds" },
  { id: "cards", label: "Cards", kind: "card", icon: "card", group: "kinds" },
  { id: "notes", label: "Notes", kind: "note", icon: "lines", group: "kinds" },
  { id: "api-keys", label: "API keys", kind: "api-key", icon: "key", group: "kinds" },
  { id: "env-sets", label: "Env sets", kind: "env-set", icon: "terminal", group: "kinds" },
  { id: "ssh-keys", label: "SSH keys", kind: "ssh-key", icon: "key", group: "kinds" },
  { id: "secrets", label: "Secrets", kind: "secret", icon: "lock", group: "kinds" },
  { id: "shared", label: "Shared with you", icon: "pass", group: "more", view: true },
  { id: "watchtower", label: "Watchtower", icon: "watch", group: "more", view: true },
  { id: "passes", label: "Passes", icon: "pass", group: "more", view: true },
  { id: "devices", label: "Devices", icon: "laptop", group: "more", view: true },
  { id: "archive", label: "Archive", icon: "file", group: "end" },
  { id: "trash", label: "Trash", icon: "close", group: "end" },
];
export const place = id => PLACES.find(p => p.id === id) || PLACES[0];

const str = v => (typeof v === "string" ? v : "");
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

/** vault.list → items, named fields only. */
export function pickItems(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return list.filter(x => x && typeof x.name === "string").map(x => {
    const kind = str(x.kind) || "secret";
    return {
      name: x.name, kind, kindLabel: str(x.label) || KIND[kind] || kind,
      description: str(x.description), fields: strs(x.fields), hosts: strs(x.hosts), url: str(x.url),
      holders: pickHolders(x), passes: num(x.passes) || 0,
      updated: num(x.updated) ?? num(x.set_at), set_by: str(x.set_by),
      rotate: x.rotate === true, reprompt: x.reprompt === true,
      state: x.state === "archived" || x.archived === true ? "archived" : x.state === "trashed" || x.trashed === true ? "trashed" : "live",
      last_used: num(x.last_used),
    };
  });
}
function pickHolders(x) {
  if (Array.isArray(x.holders)) return x.holders.map(g => ({ agent: str(g?.agent), module: str(g?.module), pass: str(g?.pass), scope: str(g?.scope), watcher: str(g?.watcher) })).filter(g => g.agent || g.module || g.pass);
  if (Array.isArray(x.grants)) return x.grants.map(g => ({ agent: "", module: str(g?.module), pass: "", scope: "", watcher: str(g?.watcher) })).filter(g => g.module);
  return [];
}

/** vault.pass.list → passes given ("to") and held ("from"). */
export function pickPasses(d) {
  const list = Array.isArray(d) ? d
    : [...(Array.isArray(d?.passes) ? d.passes.map(p => ({ ...p, direction: p.direction || "to" })) : []),
       ...(Array.isArray(d?.held) ? d.held.map(p => ({ ...p, direction: "from", holder: p.holder || p.owner })) : [])];
  return list.filter(p => p && (typeof p.id === "string" || typeof p.id === "number")).map(p => ({
    id: String(p.id), direction: p.direction === "from" ? "from" : "to",
    holder: str(p.holder), person: str(p.person), items: strs(p.items),
    scope: str(p.scope) || str(p.note), service: str(p.service), hosts: strs(p.hosts),
    mode: p.mode === "sealed" ? "sealed" : "relayed",
    state: p.state === "waiting" || p.status === "pending" ? "waiting" : p.status === "revoked" || p.revoked ? "revoked" : "active",
    expires: typeof p.expires === "number" || typeof p.expires === "string" ? p.expires : null,
  })).filter(p => p.state !== "revoked");
}

/** vault.pending → approvals waiting for a person. */
export function pickPending(d) {
  const grants = (Array.isArray(d?.grants) ? d.grants : []).map(g => ({ id: str(g.id), kind: "grant", name: str(g.name), module: str(g.module), watcher: str(g.watcher), by: str(g.by), at: num(g.at) }));
  const passes = (Array.isArray(d?.passes) ? d.passes : []).map(p => ({ id: str(p.id), kind: "pass", holder: str(p.holder), items: strs(p.items), mode: p.mode === "sealed" ? "sealed" : "relayed", by: str(p.by), at: num(p.created) }));
  return [...grants, ...passes].filter(x => x.id);
}

/** vault.devices → paired browsers. */
export function pickDevices(d) {
  return (Array.isArray(d?.devices) ? d.devices : []).filter(x => x && x.id).map(x => ({
    id: String(x.id), name: str(x.name) || "A browser", created: num(x.created), lastSeen: num(x.lastSeen), revoked: num(x.revoked), sessions: num(x.sessions) || 0,
  }));
}

/** Usage rows from vault.audit, names and actions only. */
export function pickUsage(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.entries) ? d.entries : [];
  return list.filter(u => u && num(u.at) && u.ok !== false).map(u => ({
    at: /** @type {number} */ (num(u.at)), name: str(u.name), agent: str(u.agent), pass: str(u.pass), who: str(u.who), action: str(u.action),
    project: str(u.project), relayed_by: str(u.relayed_by),
  }));
}

/** Audit actions that mean an item was used, not changed. */
export const USES = ["release", "inject", "relay", "fill", "totp", "copy", "reveal"];

/** name → last time it was used, from audit rows. */
export function lastUsed(rows) {
  const out = new Map();
  for (const r of rows) if (r.name && USES.includes(r.action) && (!out.has(r.name) || out.get(r.name) < r.at)) out.set(r.name, r.at);
  return out;
}

/** "module:gate" → "gate"; "cli" → "you, from a terminal". Plain words for an audit row's who. */
export function whoWord(who) {
  const w = String(who || "");
  if (w.startsWith("module:")) return w.slice(7).split("/")[0];
  if (w.startsWith("pass:")) return w.split(":")[2] || "a pass";
  if (w === "cli") return "You, in a terminal";
  if (w === "deck") return "You, in the Deck";
  if (w === "local" || w === "capsule") return "You";
  return w;
}

/** Filter items for a place. */
export function inPlace(items, id, fav) {
  const p = place(id);
  if (id === "archive") return items.filter(i => i.state === "archived");
  if (id === "trash") return items.filter(i => i.state === "trashed");
  const live = items.filter(i => i.state === "live");
  if (id === "favorites") return live.filter(i => fav.has(i.name));
  if (p.kind) return live.filter(i => i.kind === p.kind);
  return live;
}

/** The field copied by `c`, per kind. */
export const MAIN_FIELD = { login: "password", card: "number", note: "text", "api-key": "value", secret: "value", "ssh-key": "public" };
/** The field an env-set copies first: its first variable. */
export const mainField = it => MAIN_FIELD[it.kind] || it.fields[0] || "value";

/** Words for Watchtower's reason codes. */
export const REASON = {
  weak: ["Weak", "Easy to guess. Replace it with a generated one."],
  reused: ["Reused", "The same value is in more than one item."],
  old: ["Old", "Not changed for more than a year."],
  rotate: ["Rotate", "Marked for rotation: a copy left this box."],
  "2fa-available": ["Two-factor available", "This site offers one-time codes. Add the seed and Vyre makes them."],
  unprotected: ["Not yet protected", "Still opened without your password. Set one to move it to your personal vault."],
};

/** "Until 31 Oct", "No end date", or what the pass said. */
export function expiryWord(e, mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]) {
  if (e === null || e === "" || e === undefined) return "No end date";
  const t = typeof e === "number" ? e : /^\d{4}-\d\d-\d\d/.test(String(e)) ? Date.parse(String(e)) : NaN;
  if (!isFinite(t)) return String(e);
  const d = new Date(t);
  return `Until ${d.getDate()} ${mon[d.getMonth()]}`;
}
