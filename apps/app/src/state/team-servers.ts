// The paired servers whose own Space was named as the team's, kept on this device so My Cloud still hides them after a reload.
import { kvGet, kvSet } from "./kv";
import { keptTeamServers, readTeamServers } from "./team-server.js";

const KEY = "vyre.team.servers";

export async function teamServerIds(): Promise<string[]> {
  return readTeamServers(await kvGet(KEY));
}

export async function rememberTeamServer(id: string): Promise<void> {
  const cur = await teamServerIds();
  const next = keptTeamServers(cur, id);
  if (next.length === cur.length) return;
  await kvSet(KEY, JSON.stringify(next));
}
