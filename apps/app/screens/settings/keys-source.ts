// All settings on the real box: settings.schema, settings.get, settings.set and settings.reset at the account level, over an injected `call`.
import type { Call } from "./real-source";
import { schemaOf, type KeyValue, type Schema } from "./keys-model.ts";

export function keysSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const target = (key: string) => ({ key, level: "account" });
  return {
    schema: async (): Promise<Schema> => schemaOf(await ask("settings.schema")),
    values: async (): Promise<Map<string, KeyValue>> => new Map((((await ask<any>("settings.get"))?.settings || []) as KeyValue[]).map((s) => [s.key, s])),
    /** One key, fresh from the box. */
    one: async (key: string): Promise<KeyValue | null> => { const d = await ask<KeyValue>("settings.get", { key }); return d && d.key === key ? d : null; },
    set: (key: string, value: unknown) => ask<KeyValue>("settings.set", { ...target(key), value }),
    reset: (key: string) => ask<KeyValue>("settings.reset", target(key)),
  };
}
