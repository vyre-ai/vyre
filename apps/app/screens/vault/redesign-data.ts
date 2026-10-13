// Where the redesigned Vault gets its items: the sample world, or the real tools. Space is the owner's vault (vault.list, vault.uses, vault.reveal, vault.put, vault.delete); Mine is the signed-in
// member's own vault (vault.me.*). Nothing here holds a value: `read` fetches one at the click and the screen keeps it for the reveal time only.
import type { Call } from "./source";
import { daysLeftOf, groupOf, valueField, type VItem } from "./redesign.js";
import type { ListRow, UseRow } from "./real-model";
import { SAMPLE_EVENTS, SAMPLE_ITEMS, type Event } from "./sample-redesign";

export type Scope = "space" | "mine";
export type Loaded = { items: VItem[]; locked: boolean };
export type NewItem = { name: string; kind: string; value: string };

export interface VaultData {
  /** True for the real tools; the sample world edits sharing in memory. */
  real: boolean;
  load(scope: Scope): Promise<Loaded>;
  read(scope: Scope, item: VItem): Promise<string>;
  /** Mine only: open the member's own vault. */
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  add(scope: Scope, n: NewItem): Promise<void>;
  remove(scope: Scope, item: VItem): Promise<void>;
  /** Space: what happened to an item (vault.uses). */
  events(scope: Scope, item: VItem): Promise<Event[]>;
  /** Space: who the item is shared with and who could be picked (vault.access.get), and share or unshare (vault.access.set). */
  access?(item: VItem): Promise<{ rows: { who: string; level: "use" | "edit" }[]; people: { id: string; name: string }[] }>;
  setAccess?(item: VItem, who: string, level: "use" | "edit" | null): Promise<void>;
  /** Space: take an item away from a module or watcher (vault.revoke). */
  revokeModule?(item: VItem, who: string): Promise<void>;
}

export function sampleData(): VaultData {
  const items = [...SAMPLE_ITEMS];
  return {
    real: false,
    load: async (scope) => ({ items: items.filter((v) => (scope === "mine") === (v.sp === "mine")), locked: false }),
    read: async (_s, v) => v.secret,
    unlock: async () => {}, lock: async () => {},
    add: async (scope, n) => { items.push({ id: `n${items.length}`, sp: scope === "mine" ? "mine" : "juniper", group: groupOf(n.kind, n.name), name: n.name, detail: "Added just now", secret: n.value, usedBy: [], shared: [] }); },
    remove: async (_s, v) => { const i = items.findIndex((x) => x.id === v.id); if (i >= 0) items.splice(i, 1); },
    events: async (_s, v) => SAMPLE_EVENTS.filter((e) => e.item === v.id),
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
    const exp = (r as ListRow & { details?: { expires?: string | number } }).details?.expires;
    return {
      id: r.name, sp: "space", group: groupOf(r.kind, r.name), name: r.name.replace(/[-_]+/g, " "), detail: r.description || r.hosts[0] || r.kind, secret: "",
      daysLeft: daysLeftOf(exp), lastUsedDays: undefined,
      usedBy: r.grants.map((g) => ({ kind: g.watcher ? "agent" as const : "connection" as const, name: g.watcher ? `${g.module}/${g.watcher}` : g.module })),
      shared: [],
    };
  };
  const fieldsOf: Record<string, string[]> = {};
  return {
    real: true,
    async load(scope) {
      if (scope === "space") {
        const r = await ask<{ items?: ListRow[]; locked?: boolean }>("vault.list");
        for (const i of r.items ?? []) fieldsOf[i.name] = i.fields;
        return { items: (r.items ?? []).map(spaceItem), locked: Boolean(r.locked) };
      }
      try {
        const r = await ask<{ items: { name: string; kind: string; description: string; fields: string[]; updated: number }[] }>("vault.me.list");
        return { locked: false, items: r.items.map((i) => { fieldsOf["me/" + i.name] = i.fields; return { id: i.name, sp: "mine", group: groupOf(i.kind, i.name), name: i.name.replace(/[-_]+/g, " "), detail: i.description || i.kind, secret: "", daysLeft: null, lastUsedDays: day(i.updated), usedBy: [], shared: [] }; }) };
      } catch (e) {
        if ((e as { code?: string }).code === "locked") return { items: [], locked: true };
        throw e;
      }
    },
    async read(scope, item) {
      if (scope === "space") return String((await ask<{ value?: string }>("vault.reveal", { name: item.id, field: valueField(fieldsOf[item.id] ?? []) })).value ?? "");
      const r = await ask<{ fields: Record<string, string> }>("vault.me.get", { name: item.id });
      return r.fields[valueField(Object.keys(r.fields))] ?? "";
    },
    // The Secret Key is held by this person's devices; this build has no device store for it yet, so unlock says so instead of asking for something it cannot send.
    async unlock(password) { await ask("vault.me.account.unlock", { password, secretKey: deviceSecretKey() }); },
    async lock() { await ask("vault.me.account.lock"); },
    async add(scope, n) {
      if (scope === "space") await ask("vault.put", { name: n.name, kind: n.kind, fields: { value: n.value } });
      else await ask("vault.me.put", { name: n.name, kind: n.kind, fields: { value: n.value } });
    },
    async remove(scope, item) { await ask(scope === "space" ? "vault.delete" : "vault.me.remove", { name: item.id }); },
    async events(scope, item) {
      if (scope !== "space") return [];
      const r = await ask<{ uses?: UseRow[] }>("vault.uses", { item: item.id, limit: 20 });
      return (r.uses ?? []).map((u, i) => ({ id: `u${i}`, item: item.id, who: u.who, what: `${u.action}${u.ok ? "" : " (refused)"}`, when: when(u.at) }));
    },
    async access(item) {
      const r = await ask<{ access: { subject: string; level: "use" | "edit" }[]; people: { id: string; name: string }[] }>("vault.access.get", { name: item.id });
      return { rows: r.access.map((a) => ({ who: a.subject, level: a.level })), people: r.people };
    },
    async setAccess(item, who, level) { await ask("vault.access.set", { name: item.id, kind: "person", subject: who, level }); },
    async revokeModule(item, who) { const [module, watcher] = who.split("/"); await ask("vault.revoke", { name: item.id, module, ...(watcher ? { watcher } : {}) }); },
  };
}

/** The member's Secret Key from this device. Not stored on a device in this build (wire-identity's export and import tools bring it), so it is empty and the server refuses the unlock in words. */
function deviceSecretKey(): string { return ""; }
