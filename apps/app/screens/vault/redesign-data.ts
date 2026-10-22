// Where the Vault gets its items: the sample world, or the real tools. Two places, and they are always two different stores:
//   - the owner: Mine is the owner's items in no folder, Shared is the items in the Space's folders (both from vault.list, split by owner-mine.js splitOwner);
//   - a member: Mine is her own vault (vault.me.*), Shared is what the Space shared with her (vault.me.shared.list, folders from vault.me.vaults).
// Nothing here holds a value: `read` fetches one field at the person's click (vault.reveal, with its presence step) and the screen keeps it for the reveal time only.
import type { Call } from "./source";
import { daysLeftOf, groupOf, siteUpdate, type VItem } from "./redesign.js";
import type { ListRow, UseRow } from "./real-model";
import { kvGet, kvSet } from "../../src/state/member-key-kv";
import { createMine, deviceKeyStore, hasMine, unlockMine } from "../../src/state/member-key.js";
import { isOwnerRefusal, splitOwner } from "./owner-mine.js";
import { SAMPLE_EVENTS, SAMPLE_ITEMS, SAMPLE_NEEDS, type Event } from "./sample-redesign";
import type { Directory, Level, Share, Who } from "./ShareSheet";
import { AGENTS, GROUPS0, ME, PEOPLE } from "./share-sample";
import type { Need, Saved } from "./add-model.js";
import { shownName } from "./env-model.js";

export type Scope = "mine" | "shared";
export type Loaded = { items: VItem[]; locked: boolean; /** Mine only: the member has not made a vault yet. */ noAccount?: boolean; /** Who is looking: the owner, or a member. */ owner?: boolean };
/** What the Add sheet saves: the tool to call and its input, built by add-model.js and env-model.js. */
export type AddCall = { tool: string; input: Record<string, unknown>; plain?: string[] };
/** An item's rules (core/vault/use.js, vault.use.find): which fields are plain, their values in full, and whether an agent's script may have it. */
export type Rules = { plain: Record<string, string | null>; scripts: boolean; usedWith: string[] };
export type Suggestion = { app: string; fields: { name: string; secret: boolean; help?: string }[]; source: "space" | "ai" | "none"; why?: "no_account" | "no_answer" };

export interface VaultData {
  /** True for the real tools; the sample world edits in memory. */
  real: boolean;
  load(scope: Scope): Promise<Loaded>;
  /** One field's value, at the person's click. */
  read(scope: Scope, item: VItem, field: string): Promise<string>;
  /** The current one-time code for an item that has one (vault.totp). The secret stays on the item. */
  code?(item: VItem): Promise<{ code: string; period: number; remaining: number }>;
  /** Mine only, for a member: open her own vault, or make it (the Secret Key stays on this device). */
  unlock(password: string): Promise<void>;
  create(password: string): Promise<void>;
  lock(): Promise<void>;
  /** Save a new item; in Shared, the owner's new item then goes into the folder picked. */
  add(scope: Scope, call: AddCall, folder?: string | null): Promise<void>;
  /** An item's rules: its plain fields and their values, and Allowed in scripts (vault.use.find, the owner's items). */
  rules?(item: VItem): Promise<Rules>;
  /** Whether an agent's script may have the item (Allowed in scripts: vault.use.find reads it, vault.use.set changes it). */
  scripts?: { load(item: VItem): Promise<boolean>; set(item: VItem, on: boolean): Promise<void> };
  /** The hosts the person allows an item's secrets to go to, besides the ones written on it (Used with: vault.use.find reads them, vault.use.set replaces the list). */
  usedWith?: { set(item: VItem, hosts: string[]): Promise<void> };
  /** Save an item's fields again (Edit): every field, names in their one form, values as given. */
  update(scope: Scope, item: VItem, fields: Record<string, string>, plain: string[]): Promise<void>;
  remove(scope: Scope, item: VItem): Promise<void>;
  /** What happened to an item (vault.uses), newest first. */
  events(scope: Scope, item: VItem): Promise<Event[]>;
  /** Who can use an item, and one change (vault.access.get and vault.access.set). The owner's items only. */
  sharing?: { load(item: VItem): Promise<{ shares: Share[]; dir: Directory; me: string | null; levels?: Level[] }>; set(item: VItem, w: { id: string; kind: Who["kind"] }, level: Level | null): Promise<void> };
  /** The owner's folders in Shared (named vaults), making one, and moving an item into one or back to Mine (vault.named.*). */
  folders?: { list(): Promise<{ id: string; name: string; sub: string }[]>; make(name: string): Promise<string>; move(item: VItem, folder: string | null): Promise<void> };
  /** What Vyre's modules need from the Vault (vault.need): the owner's to fill. */
  needs?(): Promise<Need[]>;
  /** This Space's app templates (vault.templates), and a suggestion for an app by its name only (vault.template.suggest). */
  templates?(): Promise<Saved[]>;
  suggest?(app: string): Promise<Suggestion>;
  /** A module's own check that a filled need works ("Test it"). */
  test?(tool: string, input: Record<string, unknown>): Promise<string>;
  /** Mine only: save the site a login signs in to (vault.me.update merges the url field), so an agent can be lent it. Returns the bare origin saved. */
  addSite?(item: VItem, site: string): Promise<string>;
}

const say = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function sampleData(): VaultData {
  const items: VItem[] = SAMPLE_ITEMS.map((v) => ({ ...v, values: { ...(v.values ?? {}) } }));
  const held = new Map<string, Share[]>();
  const shares = (v: VItem) => held.get(v.id) ?? v.shared.map((s) => ({ id: s.who, level: (s.level === "edit" ? "edit" : "use") as Level }));
  const folders = [{ id: "team", name: "Team", sub: "Everyone in the Space can use it" }, { id: "billing", name: "Billing", sub: "Shared with Billing and Kit" }];
  return {
    real: false,
    load: async (scope) => ({ items: items.filter((v) => (scope === "mine") === (v.sp === "mine")), locked: false, owner: true }),
    read: async (_s, v, field) => v.values?.[field] ?? "",
    code: async () => ({ code: "492039", period: 30, remaining: 20 }),
    rules: async (v) => ({ plain: Object.fromEntries((v.fields ?? []).filter((f) => f.plain).map((f) => [f.name, v.values?.[f.name] ?? ""])), scripts: false, usedWith: [] }),
    scripts: { load: async () => false, set: async () => {} },
    usedWith: { set: async () => {} },
    unlock: async () => {}, create: async () => {}, lock: async () => {},
    add: async (scope, call, folder) => {
      const i = call.input as { name?: string; kind?: string; fields?: Record<string, string>; details?: { provider?: string }; module?: string; need?: string };
      const name = String(i.name ?? `${i.module}-${i.need}`);
      const f = folders.find((x) => x.id === folder) ?? null;
      items.push({ id: name, sp: scope === "mine" ? "mine" : "shared", folder: scope === "shared" ? f ?? folders[0] : null, kind: i.kind, group: groupOf(i.kind ?? "env-set", name, i.details?.provider), name: shownName(name),
        detail: Object.keys(i.fields ?? {}).join(", "), secret: "", fields: Object.keys(i.fields ?? {}).map((n) => ({ name: n, plain: (call.plain ?? []).includes(n) })), values: { ...(i.fields ?? {}) }, usedBy: [], shared: [], lastUsedDays: null });
    },
    update: async (_s, v, fields, plain) => { const x = items.find((y) => y.id === v.id); if (x) { x.values = { ...fields }; x.fields = Object.keys(fields).map((n) => ({ name: n, plain: plain.includes(n) })); x.detail = Object.keys(fields).join(", "); } },
    remove: async (_s, v) => { const i = items.findIndex((x) => x.id === v.id); if (i >= 0) items.splice(i, 1); },
    events: async (_s, v) => SAMPLE_EVENTS.filter((e) => e.item === v.id),
    addSite: async (v, site) => { const o = siteUpdate(v, site).origin; const i = items.find((x) => x.id === v.id); if (i) i.sites = [...(i.sites ?? []), o]; return o; },
    folders: {
      list: async () => folders,
      make: async (name) => { const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-"); folders.push({ id, name, sub: "Everyone in the Space can use it" }); return id; },
      move: async (v, folder) => { const x = items.find((y) => y.id === v.id); if (x) { x.sp = folder ? "shared" : "mine"; x.folder = folder ? folders.find((f) => f.id === folder) ?? null : null; } },
    },
    needs: async () => SAMPLE_NEEDS as Need[],
    templates: async () => [],
    suggest: async (app) => ({ app, fields: [], source: "none", why: "no_account" }),
    sharing: {
      load: async (v) => ({ shares: shares(v), dir: { people: PEOPLE, groups: GROUPS0, agents: AGENTS }, me: ME }),
      set: async (v, w, level) => { const cur = shares(v).filter((x) => x.id !== w.id); held.set(v.id, level ? [...cur, { id: w.id, level }] : cur); },
    },
  };
}

const day = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

type OwnerRow = ListRow & { details?: { expires?: string | number; provider?: string; plain?: string[] }; folder?: string };

/** The real tools, over a `call` (the app's box connection). A locked Mine vault says so; the screen then shows the locked card. */
export function realData(call: Call): VaultData {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  let owner: boolean | null = null;
  const rows: Record<string, OwnerRow> = {};
  /** The owner has no member vault: vault.me.* refuses the owner by design, and that refusal is how the screen knows who is looking. */
  async function isOwner(): Promise<boolean> {
    if (owner !== null) return owner;
    try { await hasMine(ask); owner = false; } catch (e) { if (isOwnerRefusal(e)) owner = true; else throw e; }
    return owner;
  }
  const folderNames = async (): Promise<Record<string, string>> => {
    const r = await ask<{ vaults: { id: string; name: string; personal: boolean }[] }>("vault.named.list").catch(() => ({ vaults: [] as { id: string; name: string; personal: boolean }[] }));
    return Object.fromEntries(r.vaults.filter((v) => !v.personal).map((v) => [v.id, v.name]));
  };
  const ownerItem = (r: OwnerRow, sp: Scope, names: Record<string, string>): VItem => {
    // which fields are plain is the item's rule (vault.use.find); until it is read, a login's username is the one shown as plain
    const plain = r.kind === "login" ? ["username"] : [];
    const slash = r.name.indexOf("/");
    return {
      id: r.name, sp, kind: r.kind, group: groupOf(r.kind, r.name, r.details?.provider), provider: r.details?.provider, sharedWithMe: slash > 0, name: shownName(slash > 0 ? r.name.slice(slash + 1) : r.name),
      detail: r.fields.join(", ") || r.description || r.kind, secret: "", url: r.url, hosts: r.hosts,
      fields: r.fields.map((n) => ({ name: n, plain: plain.includes(n) })),
      folder: r.folder ? { id: r.folder, name: names[r.folder] ?? "Folder" } : slash > 0 ? { id: r.name.slice(0, slash), name: shownName(r.name.slice(0, slash)) } : null,
      daysLeft: daysLeftOf(r.details?.expires), lastUsedDays: undefined,
      usedBy: r.grants.map((g) => ({ kind: g.watcher ? "agent" as const : "connection" as const, name: g.watcher ? `${g.module}/${g.watcher}` : g.module })),
      shared: [],
    };
  };
  const deviceKeys = deviceKeyStore({ get: kvGet, set: kvSet });
  async function rulesOf(item: VItem): Promise<Rules> {
    if (!(await isOwner())) return { plain: {}, scripts: false, usedWith: [] };
    const r = await ask<{ items?: { name: string; scripts?: boolean; used_with?: string[]; fields?: { name: string; plain?: string | null; secret?: boolean }[] }[] }>("vault.use.find", { q: item.id, limit: 50 });
    const it = (r.items ?? []).find((x) => x.name === item.id);
    return { plain: Object.fromEntries((it?.fields ?? []).filter((x) => !x.secret).map((x) => [x.name, x.plain ?? null])), scripts: Boolean(it?.scripts), usedWith: (it?.used_with ?? []).map(String) };
  }
  return {
    real: true,
    async load(scope) {
      if (await isOwner()) {
        const r = await ask<{ items?: OwnerRow[]; locked?: boolean }>("vault.list");
        for (const i of r.items ?? []) rows[i.name] = i;
        const split = splitOwner(r.items ?? []);
        const names = scope === "shared" ? await folderNames() : {};
        // the plain fields of the items in view, from their rules (vault.use.find, at most 50 a call): names only here; values come with an item's page
        const shown = (scope === "mine" ? split.mine : split.shared).map((x) => ownerItem(x, scope, names));
        const f = await ask<{ items?: { name: string; fields?: { name: string; plain?: string | null; secret?: boolean }[] }[] }>("vault.use.find", { limit: 50 }).catch(() => ({ items: [] as { name: string; fields?: { name: string; plain?: string | null; secret?: boolean }[] }[] }));
        for (const it of f.items ?? []) { const v = shown.find((x) => x.id === it.name); if (v) v.fields = (v.fields ?? []).map((fl) => ({ ...fl, plain: Boolean(it.fields?.some((x) => x.name === fl.name && !x.secret)) })); }
        return { items: shown, locked: Boolean(r.locked), owner: true };
      }
      if (scope === "shared") {
        const [r, vs] = await Promise.all([
          ask<{ items: { name: string; kind: string; can: string[]; description?: string; fields?: string[] }[] }>("vault.me.shared.list"),
          ask<{ vaults: { id: string; name: string; items: { name: string }[] }[] }>("vault.me.vaults").catch(() => ({ vaults: [] as { id: string; name: string; items: { name: string }[] }[] })),
        ]);
        const inFolder = (n: string) => vs.vaults.find((v) => v.items.some((i) => i.name === n)) ?? null;
        return { owner: false, locked: false, items: r.items.map((i) => { const f = inFolder(i.name); return { id: i.name, sp: "shared", kind: i.kind, can: i.can, group: groupOf(i.kind, i.name), name: shownName(i.name), detail: (i.fields ?? []).join(", ") || i.description || i.kind,
          fields: (i.fields ?? []).map((n) => ({ name: n, plain: false })), folder: f ? { id: f.id, name: f.name } : null, secret: "", daysLeft: null, lastUsedDays: undefined, usedBy: [], shared: [] }; }) };
      }
      if (!(await hasMine(ask))) return { items: [], locked: false, noAccount: true, owner: false };
      try {
        const r = await ask<{ items: { name: string; kind: string; description: string; fields: string[]; updated: number; sites?: string[] }[] }>("vault.me.list");
        return { locked: false, owner: false, items: r.items.filter((i) => i.kind !== "connection").map((i) => ({ id: i.name, sp: "mine", kind: i.kind, group: groupOf(i.kind, i.name), name: shownName(i.name), detail: i.fields.join(", ") || i.description || i.kind,
          ...(i.kind === "login" ? { sites: i.sites ?? [] } : {}), fields: i.fields.map((n) => ({ name: n, plain: n === "username" || n === "url" })), folder: null, secret: "", daysLeft: null, lastUsedDays: day(i.updated), usedBy: [], shared: [] })) };
      } catch (e) {
        if ((e as { code?: string }).code === "locked") return { items: [], locked: true, owner: false };
        throw e;
      }
    },
    async read(scope, item, field) {
      if (await isOwner()) return String((await ask<{ value?: string }>("vault.reveal", { name: item.id, field })).value ?? "");
      if (scope === "shared") return String((await ask<{ value?: string }>("vault.me.shared.reveal", { item: item.id, field })).value ?? "");
      const r = await ask<{ fields: Record<string, string> }>("vault.me.get", { name: item.id });
      return r.fields[field] ?? "";
    },
    async code(item) {
      const r = await ask<{ code?: string; period?: number; remaining?: number }>("vault.totp", { name: item.id });
      const period = Number(r.period);
      const remaining = Number(r.remaining);
      return { code: String(r.code ?? ""), period: Number.isFinite(period) && period > 0 ? period : 30, remaining: Number.isFinite(remaining) && remaining >= 0 ? remaining : 0 };
    },
    // The Secret Key is held by this device (src/state/member-key.js), saved when the vault is made and sent with the password at each unlock.
    async unlock(password) { await unlockMine(ask, deviceKeys, password); },
    async create(password) { await createMine(ask, deviceKeys, password); },
    async lock() { await ask("vault.me.account.lock"); },
    async addSite(item, site) { const u = siteUpdate(item, site); await ask("vault.me.update", u.input); return u.origin; },
    async add(scope, req, folder) {
      await ask(req.tool, req.input);
      const name = typeof req.input.name === "string" ? req.input.name : "";
      if (scope === "shared" && folder && name && req.tool === "vault.put") await ask("vault.named.move", { item: name, vault: folder });
      // the plain fields are the item's rule (core/vault/use.js): showing a field to agents is a loosening, so the server asks for the person's yes
      if (req.plain?.length && name && (await isOwner())) await ask("vault.use.set", { name, plain: req.plain });
    },
    rules: rulesOf,
    scripts: {
      async load(item) { return (await rulesOf(item)).scripts; },
      async set(item, on) { await ask("vault.use.set", { name: item.id, scripts: on }); },
    },
    usedWith: { async set(item, hosts) { await ask("vault.use.set", { name: item.id, hosts }); } },
    async update(scope, item, fields, plain) {
      if (await isOwner()) {
        const r = rows[item.id];
        await ask("vault.put", { name: item.id, kind: r?.kind ?? item.kind ?? "env-set", fields, ...(r?.url ? { url: r.url } : {}), ...(r?.hosts?.length ? { hosts: r.hosts } : {}) });
        await ask("vault.use.set", { name: item.id, plain });
        return;
      }
      if (scope === "shared") { for (const [field, v] of Object.entries(fields)) await ask("vault.me.shared.update", { item: item.id, fields: { [field]: v } }); return; }
      await ask("vault.me.update", { name: item.id, fields });
    },
    async remove(_scope, item) { await ask((await isOwner()) ? "vault.delete" : "vault.me.remove", { name: item.id }); },
    async events(_scope, item) {
      if (!(await isOwner())) return [];
      const r = await ask<{ uses?: UseRow[] }>("vault.uses", { item: item.id, limit: 20 });
      return (r.uses ?? []).map((u, i) => ({ id: `u${i}`, item: item.id, who: u.who, what: `${u.action}${u.ok ? "" : " (refused)"}`, when: when(u.at) }));
    },
    folders: {
      async list() {
        const r = await ask<{ vaults: { id: string; name: string; personal: boolean; shared: number; items: number }[] }>("vault.named.list");
        return r.vaults.filter((v) => !v.personal).map((v) => ({ id: v.id, name: v.name, sub: `${say(v.items, "item")}, ${v.shared ? `shared with ${say(v.shared, "holder")}` : "not shared yet"}` }));
      },
      // A new folder is the Space's: everyone in it can use what is inside without seeing it (people may be given more, item by item or on the folder's page).
      async make(name) {
        const r = await ask<{ vault: { id: string } }>("vault.named.create", { name });
        await ask("vault.named.access.set", { vault: r.vault.id, kind: "everyone", subject: "everyone", level: "use" });
        return r.vault.id;
      },
      async move(item, folder) { await ask("vault.named.move", { item: item.id, vault: folder }); },
    },
    async needs() { if (!(await isOwner())) return []; return (await ask<{ needs: Need[] }>("vault.need")).needs; },
    async templates() { if (!(await isOwner())) return []; return (await ask<{ templates: Saved[] }>("vault.templates")).templates; },
    async suggest(app) {
      if (!(await isOwner())) return { app, fields: [], source: "none", why: "no_answer" };
      return ask<Suggestion>("vault.template.suggest", { app });
    },
    async test(tool, input) { const r = await ask<{ label?: string; to?: string }>(tool, input); return r?.to ? `Sent a test to ${r.to}. It works.` : "It works."; },
    sharing: {
      async load(item) {
        const r = await ask<{ access: { kind: Who["kind"] | "team"; subject: string; level: Level }[]; people: { id: string; name: string; role?: string }[]; teams?: { id: string; name: string; people?: string[]; agents?: string[] }[]; agents?: { id: string; name: string }[] }>("vault.access.get", { name: item.id });
        const dir: Directory = {
          people: r.people.map((p) => ({ id: p.id, kind: "person", name: p.name, sub: p.role ?? "" })),
          groups: (r.teams ?? []).map((t) => ({ id: t.id, kind: "group", name: t.name, people: t.people ?? [], agents: t.agents ?? [] })),
          agents: (r.agents ?? []).map((a) => ({ id: a.id, kind: "agent", name: a.name })),
        };
        // All three levels work for a member (core/vault/tools/reader.js); an API credential is only ever used through Vyre, so it is offered Can use alone.
        return { shares: r.access.map((a) => ({ id: a.subject, level: a.level })), dir, me: null, levels: item.kind === "api-credential" ? ["use"] : ["use", "reveal", "edit"] };
      },
      async set(item, w, level) { await ask("vault.access.set", { name: item.id, kind: w.kind === "group" ? "team" : w.kind, subject: w.id, level }); },
    },
  };
}
