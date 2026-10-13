// The connected AI's calls on the real box (mcpconn.*), over an injected `call`. The key is written to a file on the computer that runs `vyre mcp` and is never sent back.
import type { Call } from "./real-source";
import { changesOf, connectionsOf, type Change, type Connection, type Made } from "./mcp-model.ts";

export function mcpSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<Connection[]> => connectionsOf(await ask("mcpconn.list")),
    activity: async (): Promise<Change[]> => changesOf(await ask("mcpconn.activity")),
    connect: (client?: string): Promise<Made> => ask("mcpconn.connect", client ? { client } : {}),
    revoke: (id: string) => ask("mcpconn.revoke", { id }),
  };
}
