// @ts-check
// The fake ssh's port forward: 127.0.0.1:<local> on "the Mac" to [::1]:<remote> on "the server".
// Writes "ok" (or the bind error) to the ready file, then relays until killed.

import fs from "node:fs";
import net from "node:net";

const [local, remote, ready] = process.argv.slice(2);
const server = net.createServer(c => {
  const u = net.connect(Number(remote), "::1");
  c.pipe(u); u.pipe(c);
  c.on("error", () => u.destroy());
  u.on("error", () => c.destroy());
});
server.on("error", e => { fs.writeFileSync(ready, e.message); process.exit(1); });
server.listen(Number(local), "127.0.0.1", () => fs.writeFileSync(ready, "ok"));
process.on("SIGTERM", () => process.exit(0));
