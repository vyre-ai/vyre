// Connections on the real box, over an injected `call` (and `events` for the device sign-in).
import type { Call } from "./real-source";
import { githubFlowOf, modeUpdate, pickAccounts, pickGithubAccounts, pickGoogleTest, pickServers, pickTest, type GithubFlow, type Mode, type Server } from "./connections-model.ts";

export function connectionsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  /** One section's read: its rows, or the reason it has none (a module that is not running). */
  async function section<T>(f: () => Promise<T[]>): Promise<{ rows: T[]; error: string }> {
    try { return { rows: await f(), error: "" }; } catch (e) { return { rows: [], error: (e as Error).message || "That did not load." }; }
  }
  return {
    servers: () => section(async () => pickServers(await ask("mcp.servers"))),
    accounts: () => section(async () => pickAccounts(await ask("google.accounts"))),
    /** The github module may not be there at all: no rows and no error. */
    github: async () => { try { return { rows: pickGithubAccounts(await ask("github.accounts")), error: "" }; } catch (e) { return { rows: [], error: (e as { code?: string }).code === "not_found" ? "" : (e as Error).message }; } },
    test: async (name: string) => pickTest(await ask("mcp.test", { name })),
    restart: (name: string) => ask("mcp.restart", { name }),
    remove: (name: string) => ask("mcp.remove", { name }),
    setMode: (s: Server, tool: string, mode: Mode) => ask("mcp.update", modeUpdate(s, tool, mode)),
    googleTest: async (name: string) => pickGoogleTest(await ask("google.test", { name })),
    googleRemove: (name: string) => ask("google.remove", { name }),
    githubRemove: (name: string) => ask<{ warning?: string }>("github.remove", { name }),
    /** A device sign-in: the code to type at GitHub. Null when GitHub gave none. */
    githubStart: async (name: string): Promise<GithubFlow | null> => githubFlowOf(await ask("github.connect", { name }), name),
    /** The other way in: a token the person made at GitHub. Sent once. */
    githubToken: (name: string, token: string) => ask<{ login?: string; repos?: number }>("github.connect", { name, token }),
    githubCancel: (id: string) => ask("github.connect.cancel", { id }),
  };
}
