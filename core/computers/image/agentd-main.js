// @ts-check
// agentd-main: starts agentd inside the computer. It listens on a UNIX socket (root, mode 0600), never on a TCP port, so no agent in the computer's one network namespace can reach it; vyred
// reaches it only by running agentd-client.js with `docker exec` (the exact exec shape policy.js allows). The token comes from a root-only file, not from the environment or the command line.

import fs from "node:fs";
import { createAgentd } from "./agentd-server.js";

const SOCKET = process.env.AGENTD_SOCKET || "/run/agentd.sock";
const TOKEN_FILE = process.env.AGENTD_TOKEN_FILE || "/var/lib/vyre/.agentd-token";

/** @param {{ socket?: string, tokenFile?: string, run?: (argv: string[]) => Promise<void> }} [o] */
export function startAgentd(o = {}) {
  const socket = o.socket || SOCKET;
  const token = fs.readFileSync(o.tokenFile || TOKEN_FILE, "utf8").trim();
  if (token.length < 32) throw new Error("agentd: the token file holds no token");
  try { fs.unlinkSync(socket); } catch { /* none left */ }
  const server = createAgentd({ token, ...(o.run ? { run: o.run } : {}) });
  const old = process.umask(0o177);
  server.listen(socket);
  process.umask(old);
  server.on("listening", () => { try { fs.chmodSync(socket, 0o600); } catch { /* the umask already did it */ } });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("agentd-main.js")) startAgentd();
