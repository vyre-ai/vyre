#!/usr/bin/env node
// A stand-in for the Wink core daemon in unit tests. It opens the --socket path (mode 0666, the way
// the real one does), records its argv beside it, and stays up until it is told to stop.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || "").slice(n.length + 3);
const sock = arg("socket");
fs.writeFileSync(path.join(path.dirname(sock), "daemon-argv.json"), JSON.stringify(process.argv.slice(2)));
try { fs.unlinkSync(sock); } catch { /* none */ }
const server = net.createServer(c => c.end());
server.listen(sock, () => { fs.chmodSync(sock, 0o666); });
process.on("SIGTERM", () => { server.close(); try { fs.unlinkSync(sock); } catch { /* gone */ } process.exit(0); });
setInterval(() => {}, 1 << 30);
