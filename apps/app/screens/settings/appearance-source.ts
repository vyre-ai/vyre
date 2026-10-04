// Appearance's calls on the real box: settings.get and settings.set for appearance.scheme, over an injected `call`.
import type { Scheme } from "./appearance-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function appearanceSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    scheme: () => ask<{ value: unknown; source?: string }>("settings.get", { key: "appearance.scheme" }),
    setScheme: (value: Scheme) => ask<unknown>("settings.set", { key: "appearance.scheme", value, level: "account" }),
  };
}
