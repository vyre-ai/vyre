#!/usr/bin/env node
// @ts-check
// Windows CI only (ADR 0037's LOW): tries to open the given socket path and reports whether it
// connected. Used twice by the windows-socket-acl CI job: run as a second local user, a
// connection here must fail (the ACL is doing its job); run as the socket's owner, it must
// succeed (the ACL is not so tight it locks the owner out too). Exit 0 = connected, 1 = refused
// or errored, so the workflow can read either outcome without parsing this script's stdout.
//
//   node scripts/win-connect-probe.mjs <socket-path>

import net from "node:net";

const sock = process.argv[2];
if (!sock) { console.error("usage: win-connect-probe.mjs <socket-path>"); process.exit(2); }

const conn = net.createConnection(sock);
const timer = setTimeout(() => { console.error("timed out waiting to connect"); conn.destroy(); process.exit(1); }, 5000);
conn.once("connect", () => { clearTimeout(timer); console.log("connected"); conn.destroy(); process.exit(0); });
conn.once("error", e => { clearTimeout(timer); console.error(`could not connect: ${e.message}`); process.exit(1); });
