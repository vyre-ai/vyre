// @ts-check
// agentd-main: starts agentd inside the computer, as the dedicated agentctl user (never root; it keeps only CAP_SETUID and CAP_SETGID). It listens on a UNIX socket owned by agentctl, mode 0600,
// never on a TCP port, so no agent in the computer's one network namespace can reach it; vyred reaches it only by `docker exec` of /opt/agentd/client as agentctl (the one exec policy.js allows).
// The token comes from agentctl's own 0400 file, not from the environment or the command line.

import fs from "node:fs";
import { createAgentd } from "./agentd-server.js";
import { Tickets, createRelay, RELAY_PORT } from "./agentd-relay.js";

// Constants, not environment: no variable can redirect agentd or its client. Tests pass their own paths as arguments.
export const SOCKET = "/var/lib/vyre/agentd/agentd.sock";
export const TOKEN_FILE = "/var/lib/vyre/agentd/token";

/** @param {{ socket?: string, tokenFile?: string, run?: (argv: string[]) => Promise<void>, exec?: Parameters<typeof createAgentd>[0]["exec"], shot?: Parameters<typeof createAgentd>[0]["shot"], relayPort?: number, spawn?: Parameters<typeof createRelay>[0]["spawn"] }} [o] */
export function startAgentd(o = {}) {
  const socket = o.socket || SOCKET;
  const token = fs.readFileSync(o.tokenFile || TOKEN_FILE, "utf8").trim();
  if (token.length < 32) throw new Error("agentd: the token file holds no token");
  try { fs.unlinkSync(socket); } catch { /* none left */ }
  const tickets = new Tickets();
  const server = createAgentd({ token, tickets, ...(o.run ? { run: o.run } : {}), ...(o.exec ? { exec: o.exec } : {}), ...(o.shot ? { shot: o.shot } : {}) });
  // the screens' way in: a TCP port that says nothing to a connection without a ticket vyred registered over the channel above
  const relay = createRelay({ tickets, ...(o.spawn ? { spawn: o.spawn } : {}) });
  relay.listen(o.relayPort ?? RELAY_PORT);
  server.on("close", () => relay.close());
  Object.assign(server, { relay });
  const old = process.umask(0o177);
  server.listen(socket);
  process.umask(old);
  server.on("listening", () => { try { fs.chmodSync(socket, 0o600); } catch { /* the umask already did it */ } });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("agentd-main.js")) startAgentd();
