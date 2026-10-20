// Where the redesigned Vault gets its items: the sample world, or the real tools. Space is the owner's vault (vault.list, vault.uses, vault.reveal, vault.put, vault.delete); Mine is the signed-in
// member's own vault (vault.me.*). Nothing here holds a value: `read` fetches one at the click and the screen keeps it for the reveal time only.
import type { Call } from "./source";
import { daysLeftOf, groupOf, siteUpdate, valueField, type VItem } from "./redesign.js";
import type { ListRow, UseRow } from "./real-model";
import { kvGet, kvSet } from "../../src/state/member-key-kv";
import { createMine, deviceKeyStore, hasMine, unlockMine } from "../../src/state/member-key.js";
import { isOwnerRefusal, toolScope } from "./owner-mine.js";
import { SAMPLE_EVENTS, SAMPLE_ITEMS, type Event } from "./sample-redesign";
import type { Directory, Level, Share, Who } from "./ShareSheet";
import { AGENTS, GROUPS0, ME, PEOPLE } from "./share-sample";

export type Scope = "space" | "mine";
export type Loaded = { items: VItem[]; locked: boolean; /** Mine only: the member has not made a vault yet. */ noAccount?: boolean; /** Space only: the space's own vault key is not made yet (it is made the first time something is saved with approval). */ noSpaceVault?: boolean };
/** What the Add sheet saves: the tool to call (vault.put, vault.me.put, or an SSH tool) and its input, built by add-model.js. */
export type AddCall = { tool: string; input: Record<string, unknown> };

export interface VaultData {
  /** True for the real tools; the sample world edits sharing in memory. */
  real: boolean;
  load(scope: Scope): Promise<Loaded>;
  read(scope: Scope, item: VItem): Promise<string>;
  /** Mine only: open the member's own vault, or make it (the Secret Key stays on this device). */
  unlock(password: string): Promise<void>;
  create(password: string): Promise<void>;
  lock(): Promise<void>;
  add(scope: Scope, call: AddCall): Promise<void>;
  remove(scope: Scope, item: VItem): Promise<void>;
  /** Space: what happened to an item (vault.uses). */
  events(scope: Scope, item: VItem): Promise<Event[]>;
  /** Space: who the item is shared with and who could be picked (vault.access.get), and share or unshare (vault.access.set). */
  access?(item: VItem): Promise<{ rows: { who: string; level: "use" | "edit" }[]; people: { id: string; name: string }[] }>;
  setAccess?(item: VItem, who: string, level: "use" | "edit" | null): Promise<void>;
  /** Space: who an item is shared with (people, groups and agents at Fill in, Read, Edit and rotate), the directory to pick from, and one change (vault.access.get and vault.access.set). */
  sharing?: { load(item: VItem): Promise<{ shares: Share[]; dir: Directory; me: string | null; levels?: Level[] }>; set(item: VItem, w: { id: string; kind: Who["kind"] }, level: Level | null): Promise<void> };
  /** Space: the vaults an item can move to, and the move (vault.named.list, vault.named.move). */
  moving?: { list(): Promise<{ id: string; name: string; sub: string }[]>; move(item: VItem, vault: string | null): Promise<void> };
  /** Mine: who one of the member's app connections is shared with (a person, a group or an agent she may instruct, at Fill in only), and one change (vault.me.connection.*). `info` says what it connects to. */
  connectionSharing?: { load(item: VItem): Promise<{ shares: Share[]; dir: Directory; me: string | null; info?: { account: string; how: string } }>; set(item: VItem, w: { id: string; kind: Who["kind"] }, level: Level | null): Promise<void> };
  /** Space: take an item away from a module or watcher (vault.revoke). */
  revokeModule?(item: VItem, who: string): Promise<void>;
  /** Space: whether an agent's script may have the item (Allowed in scripts: vault.use.find reads it, vault.use.set changes it). */
  scripts?: { load(item: VItem): Promise<boolean>; set(item: VItem, on: boolean): Promise<void> };
  /** Mine only: save the site a login signs in to (vault.me.update merges the url field), so an agent can be lent it. Returns the bare origin saved. */
  addSite?(item: VItem, site: string): Promise<string>;
}

export function sampleData(): VaultData {
  const items = [...SAMPLE_ITEMS];
  const held = new Map<string, Share[]>();
  return {
    real: false,
    load: async (scope) => ({ items: items.filter((v) => (scope === "mine") === (v.sp === "mine")), locked: false }),
    read: async (_s, v) => v.secret,
    unlock: async () => {}, create: async () => {}, lock: async () => {},
    add: async (scope, call) => {
      const i = call.input as { name: string; kind?: string; fields?: Record<string, string>; details?: { provider?: string } };
      const kind = call.tool.startsWith("vault.ssh") ? "ssh-key" : i.kind ?? "api-key";
      items.push({ id: `n${items.length}`, sp: scope === "mine" ? "mine" : "juniper", group: groupOf(kind, i.name, i.details?.provider), name: i.name.replace(/[-_]+/g, " "), detail: "Added just now", secret: Object.values(i.fields ?? {})[0] ?? "", usedBy: [], shared: [] });
    },
    remove: async (_s, v) => { const i = items.findIndex((x) => x.id === v.id); if (i >= 0) items.splice(i, 1); },
    events: async (_s, v) => SAMPLE_EVENTS.filter((e) => e.item === v.id),
    addSite: async (v, site) => { const o = siteUpdate(v, site).origin; const i = items.find((x) => x.id === v.id); if (i) i.sites = [...(i.sites ?? []), o]; return o; },
    moving: { list: async () => [{ id: "acme", name: "Northwind Bakery (client)", sub: "Shared with Billing and Dana" }, { id: "marketing", name: "Marketing", sub: "Shared with Marketing and Juno" }], move: async () => {} },
    connectionSharing: {
      load: async (v) => ({ shares: held.get(v.id) ?? [{ id: "kit", level: "use" as Level }], dir: { people: PEOPLE, groups: GROUPS0, agents: AGENTS }, me: ME, info: { account: "alex@juniperstudio.example.com", how: "You connected it" } }),
      set: async (v, w, level) => { const cur = (held.get(v.id) ?? [{ id: "kit", level: "use" as Level }]).filter((x) => x.id !== w.id); held.set(v.id, level ? [...cur, { id: w.id, level }] : cur); },
    },
    sharing: {
      load: async (v) => ({ shares: (held.get(v.id) ?? v.shared.map((s) => ({ id: s.who, level: (s.level === "edit" ? "edit" : "use") as Level }))), dir: { people: PEOPLE, groups: GROUPS0, agents: AGENTS }, me: ME }),
      set: async (v, w, level) => {
        const cur = (held.get(v.id) ?? v.shared.map((s) => ({ id: s.who, level: (s.level === "edit" ? "edit" : "use") as Level }))).filter((x) => x.id !== w.id);
        held.set(v.id, level ? [...cur, { id: w.id, level }] : cur);
      },
    },
  };
}

const day = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The real tools, over a `call` (the app's box connection). A locked Mine vault says so; the screen then shows the locked card. */
export function realData(call: Call): VaultData {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const spaceItem = (r: ListRow): VItem => {
    const det = (r as ListRow & { details?: { expires?: string | number; provider?: string } }).details;
    const exp = det?.expires;
    return {
      // a name with a slash is an item in a shared vault (core/vault/shared.js): it came from someone else
      id: r.name, sp: "space", kind: r.kind, group: groupOf(r.kind, r.name, det?.provider), sharedWithMe: r.name.includes("/"), name: r.name.replace(/[-_]+/g, " "), detail: r.description || r.hosts[0] || r.kind, secret: "",
      daysLeft: daysLeftOf(exp), lastUsedDays: undefined,
      usedBy: r.grants.map((g) => ({ kind: g.watcher ? "agent" as const : "connection" as const, name: g.watcher ? `${g.module}/${g.watcher}` : g.module })),
      shared: [],
    };
  };
  /** The space's id when its own vault key is not made yet, else null. A server that cannot say leaves the screen as it was. */
  async function spaceVaultId(): Promise<string | null> {
    try {
      const me = await ask<{ space?: string }>("records.me");
      const space = String(me?.space ?? "");
      if (!/^spc_[a-z2-7]{8,}$/.test(space)) return null;
      const st = await ask<{ exists?: boolean }>("vault.space.status", { space });
      if (st?.exists === false) return space;
    } catch { /* leave it */ }
    return null;
  }
  const fieldsOf: Record<string, string[]> = {};
  let owner = false;
  /** The owner's vault (vault.list), shown under Space, or under Mine for the owner. */
  async function loadSpace(scope0: Scope) {
        const r = await ask<{ items?: ListRow[]; locked?: boolean }>("vault.list");
        for (const i of r.items ?? []) fieldsOf[i.name] = i.fields;
        const items = (r.items ?? []).map(spaceItem);
        return { items: scope0 === "mine" ? items.map((i) => ({ ...i, sp: "mine" as const })) : items, locked: Boolean(r.locked), ...((await spaceVaultId()) === null ? {} : { noSpaceVault: true }) };
      
  }
  const deviceKeys = deviceKeyStore({ get: kvGet, set: kvSet });
  return {
    real: true,
    async load(scope0) {
      // The owner has no member vault: once vault.me.* has refused the owner, the Mine tab shows the owner's own vault (vault.*), and every later call on it uses the same tools.
      const scope = toolScope(owner, scope0);
      if (scope === "space") return loadSpace(scope0);
      try { if (!(await hasMine(ask))) return { items: [], locked: false, noAccount: true }; } catch (e) { if (isOwnerRefusal(e)) { owner = true; return loadSpace(scope0); } throw e; }
      try {
        const r = await ask<{ items: { name: string; kind: string; description: string; fields: string[]; updated: number; sites?: string[] }[] }>("vault.me.list");
        const own = r.items.map((i) => { fieldsOf["me/" + i.name] = i.fields; return { id: i.name, sp: "mine", kind: i.kind, group: groupOf(i.kind, i.name), name: i.name.replace(/[-_]+/g, " "), detail: i.description || i.kind, ...(i.kind === "login" ? { sites: i.sites ?? [] } : {}), secret: "", daysLeft: null, lastUsedDays: day(i.updated), usedBy: [], shared: [] }; });
        // What the firm key lets her act as (her Google account): listed beside her apps, read only, nothing stored in her vault.
        const prov = await ask<{ accounts: { app: string; account: string }[] }>("vault.me.provisioned").catch(() => ({ accounts: [] as { app: string; account: string }[] }));
        const provided: VItem[] = prov.accounts.map((a) => ({ id: `provisioned:${a.app}`, sp: "mine", kind: "provisioned", group: "Apps you connected", name: a.app, detail: `Acts as ${a.account}`, secret: "", daysLeft: null, lastUsedDays: undefined, usedBy: [], shared: [] }));
        return { locked: false, items: [...provided, ...own] };
      } catch (e) {
        if ((e as { code?: string }).code === "locked") return { items: [], locked: true };
        throw e;
      }
    },
    async read(scope0, item) {
      const scope = toolScope(owner, scope0);
      if (scope === "space") return String((await ask<{ value?: string }>("vault.reveal", { name: item.id, field: valueField(fieldsOf[item.id] ?? []) })).value ?? "");
      const r = await ask<{ fields: Record<string, string> }>("vault.me.get", { name: item.id });
      return r.fields[valueField(Object.keys(r.fields))] ?? "";
    },
    // The Secret Key is held by this device (src/state/member-key.js), saved when the vault is made and sent with the password at each unlock.
    async unlock(password) { await unlockMine(ask, deviceKeys, password); },
    async create(password) { await createMine(ask, deviceKeys, password); },
    async lock() { await ask("vault.me.account.lock"); },
    async addSite(item, site) { const u = siteUpdate(item, site); await ask("vault.me.update", u.input); return u.origin; },
    async add(_scope, req) { await ask(req.tool, req.input); },
    async remove(scope, item) { await ask(toolScope(owner, scope) === "space" ? "vault.delete" : "vault.me.remove", { name: item.id }); },
    async events(scope, item) {
      if (toolScope(owner, scope) !== "space") return [];
      const r = await ask<{ uses?: UseRow[] }>("vault.uses", { item: item.id, limit: 20 });
      return (r.uses ?? []).map((u, i) => ({ id: `u${i}`, item: item.id, who: u.who, what: `${u.action}${u.ok ? "" : " (refused)"}`, when: when(u.at) }));
    },
    async access(item) {
      const r = await ask<{ access: { subject: string; level: "use" | "edit" }[]; people: { id: string; name: string }[] }>("vault.access.get", { name: item.id });
      return { rows: r.access.map((a) => ({ who: a.subject, level: a.level })), people: r.people };
    },
    async setAccess(item, who, level) { await ask("vault.access.set", { name: item.id, kind: "person", subject: who, level }); },
    moving: {
      async list() { const r = await ask<{ vaults: { id: string; name: string; personal: boolean; shared: number }[] }>("vault.named.list"); return r.vaults.filter((v) => !v.personal).map((v) => ({ id: v.id, name: v.name, sub: v.shared ? `Shared with ${v.shared} ${v.shared === 1 ? "holder" : "holders"}` : "Only you" })); },
      async move(item, vault) { await ask("vault.named.move", { item: item.id, vault }); },
    },
    connectionSharing: {
      async load(item) {
        const [sh, dr, me] = await Promise.all([
          ask<{ shares: { kind: Who["kind"] | "team"; subject: string; level: Level }[] }>("vault.me.connection.shares", { name: item.id }),
          ask<{ people: { id: string; name: string; role?: string }[]; groups: { id: string; name: string; people?: string[]; agents?: string[] }[]; agents: { id: string; name: string; instructors?: string[] }[] }>("vault.me.connection.directory"),
          ask<{ fields: Record<string, string> }>("vault.me.get", { name: item.id }),
        ]);
        const dir: Directory = {
          people: dr.people.map((p) => ({ id: p.id, kind: "person", name: p.name, sub: p.role ?? "" })),
          groups: dr.groups.map((g) => ({ id: g.id, kind: "group", name: g.name, people: g.people ?? [], agents: g.agents ?? [] })),
          agents: dr.agents.map((a) => ({ id: a.id, kind: "agent", name: a.name, instructors: a.instructors ?? [] })),
        };
        const f = me.fields ?? {};
        return { shares: sh.shares.map((s) => ({ id: s.subject, level: s.level })), dir, me: null, info: { account: f.server_url ? new URL(f.server_url).host : "", how: f.connected_by ? "You connected it" : "" } };
      },
      async set(item, w, level) { await ask("vault.me.connection.share", { name: item.id, kind: w.kind === "group" ? "team" : w.kind, subject: w.id, level }); },
    },
    sharing: {
      async load(item) {
        const r = await ask<{ access: { kind: Who["kind"] | "team"; subject: string; level: Level }[]; people: { id: string; name: string; role?: string }[]; teams?: { id: string; name: string; people?: string[]; agents?: string[] }[]; agents?: { id: string; name: string }[] }>("vault.access.get", { name: item.id });
        const dir: Directory = {
          people: r.people.map((p) => ({ id: p.id, kind: "person", name: p.name, sub: p.role ?? "" })),
          groups: (r.teams ?? []).map((t) => ({ id: t.id, kind: "group", name: t.name, people: t.people ?? [], agents: t.agents ?? [] })),
          agents: (r.agents ?? []).map((a) => ({ id: a.id, kind: "agent", name: a.name })),
        };
        // All three levels work for a member now (core/vault/tools/reader.js); an API credential is only ever used through Vyre, so it is offered Fill in alone.
        return { shares: r.access.map((a) => ({ id: a.subject, level: a.level })), dir, me: null, levels: item.kind === "api-credential" ? ["use"] : ["use", "reveal", "edit"] };
      },
      async set(item, w, level) { await ask("vault.access.set", { name: item.id, kind: w.kind === "group" ? "team" : w.kind, subject: w.id, level }); },
    },
    async revokeModule(item, who) { const [module, watcher] = who.split("/"); await ask("vault.revoke", { name: item.id, module, ...(watcher ? { watcher } : {}) }); },
    scripts: {
      async load(item) { const r = await ask<{ items: { name: string; scripts?: boolean }[] }>("vault.use.find", { q: item.id, limit: 50 }); return Boolean((r.items ?? []).find((x) => x.name === item.id)?.scripts); },
      async set(item, on) { await ask("vault.use.set", { name: item.id, scripts: on }); },
    },
  };
}
