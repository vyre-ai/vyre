// This computer on the real box, over an injected `call`. Each read answers null when the box has no such tool or does not answer, so a section is left out rather than shown empty.
import type { Call } from "./real-source";

export function systemSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const maybe = async <T = any>(tool: string, input: Record<string, unknown> = {}): Promise<T | null> => { try { return await ask<T>(tool, input); } catch { return null; } };
  return {
    info: () => ask<any>("system.info"),
    /** Empty name goes back to the default. */
    rename: (name: string) => ask<any>("system.rename", { name: name.trim() }),
    recall: () => maybe("recall.status"),
    reindex: () => ask("recall.index"),
    hooks: () => maybe("hooks.list"),
    hooksStatus: () => maybe("hooks.status"),
    /** The webhook listener and its routes are the owner's own acts; each takes the person's yes. */
    hooksEnable: (on: boolean) => ask("hooks.enable", { on }),
    hooksOpen: (name: string, scheme: string, header: string, secret: string) => ask<any>("hooks.open", { name, verify: { scheme, ...(header.trim() ? { header: header.trim() } : {}), secret } }),
    hooksClose: (name: string) => ask("hooks.close", { name }),
    wink: () => maybe("network.wink.status"),
    egress: () => maybe("computers.egress.status"),
    handback: () => maybe("computers.handback.status"),
    setHandback: (minutes: number) => ask<any>("computers.handback.set", { minutes }),
    drive: () => maybe("files.drive.status"),
    /** The share's access: "ro" or "rw". */
    setAccess: (name: string, mode: "ro" | "rw") => ask<{ access?: string }>("files.drive.access", { name, mode }),
    audit: () => ask<any>("files.drive.audit"),
    testPush: () => ask("push.test"),
  };
}
