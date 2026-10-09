// The Vault's import calls over an injected `call` (the app's box connection, or a fake box in a test): vault.import.preview and vault.import for an export the person picked (its bytes go to the box
// once, base64, and are not kept here), vault.env.scan to find .env files in their projects, and vault.import with `files` and `rewrite` to bring those in. A value never comes back from any of them.
import type { Imported, Preview, Scan } from "./import-model";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
/** A file the person picked: its name and its bytes as base64. */
export type Picked = { name: string; base64: string };

export function importSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const bytes = (f: Picked) => ({ content: f.base64, filename: f.name });
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pairs = (v: unknown): { from: string; to: string }[] => (Array.isArray(v) ? v.filter((x): x is { from: string; to: string } => !!x && typeof x.from === "string" && typeof x.to === "string") : []);
  return {
    /** What the file would add, by name and count. Asks for the person's presence on the box. */
    async preview(f: Picked): Promise<Preview> {
      const r = await ask<Partial<Preview>>("vault.import.preview", bytes(f));
      return {
        format: String(r?.format ?? ""), ...(typeof r?.token === "string" ? { token: r.token } : {}), counts: r?.counts && typeof r.counts === "object" ? r.counts : {},
        add: list(r?.add), same: list(r?.same), conflicts: Array.isArray(r?.conflicts) ? r!.conflicts!.filter((c) => c && typeof c.name === "string") : [], renamed: pairs(r?.renamed), skipped: list(r?.skipped),
      };
    },
    /** The import itself, bound to the preview by its token. `useFile` takes the file's passwords where they differ (the old ones stay in history); otherwise those are left as they are. */
    async run(f: Picked, token: string | undefined, useFile: boolean): Promise<Imported> {
      const r = await ask<Partial<Imported>>("vault.import", { ...bytes(f), ...(token ? { token } : {}), conflicts: useFile ? "update" : "skip" });
      return { format: String(r?.format ?? ""), added: list(r?.added), updated: list(r?.updated), same: list(r?.same), conflicts: list(r?.conflicts), renamed: pairs(r?.renamed), skipped: list(r?.skipped) };
    },
    /** The .env files in the person's projects that hold secrets: names and counts. A box without the tool answers null. */
    async scan(): Promise<Scan | null> {
      const r = await call<Partial<Scan>>("vault.env.scan", {});
      if (r.error) { if (["denied", "not_found", "no_such_tool", "not_available"].includes(r.error.code)) return null; throw Object.assign(new Error(r.error.message), { code: r.error.code }); }
      return { files: Array.isArray(r.data?.files) ? r.data!.files! : [], scanned: Number(r.data?.scanned ?? 0), templates: Number(r.data?.templates ?? 0), truncated: Boolean(r.data?.truncated) };
    },
    /** Move the keys of these files into the Vault and swap each value in the file for a vault:// reference. One call, one yes. */
    async moveEnv(files: string[]): Promise<Imported> {
      const r = await ask<Partial<Imported>>("vault.import", { files, rewrite: true });
      return {
        format: "env", added: list(r?.added), updated: list(r?.updated), same: list(r?.same), conflicts: list(r?.conflicts), renamed: pairs(r?.renamed), skipped: list(r?.skipped),
        rewritten: list(r?.rewritten), unchanged: list(r?.unchanged), committed: list(r?.committed),
      };
    },
  };
}
