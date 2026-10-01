// The restricted Docker proxy (core/dockerproxy), on a free high port of this machine, pinned to
// the proof's own network, image and label prefix. Run under nice/ionice by run.sh.
//   node proxy-up.mjs <port> <bearer-file> [network] [image] [label-prefix]
import { createProxy, loadPolicy } from "../../core/dockerproxy/proxy.js";
import { ensure } from "../../lib/bearer/index.js";

const [port, bearerFile, network = "csproof-net", image = "csproof-computer:test", labelPrefix = "csproof"] = process.argv.slice(2);
if (!port || !bearerFile) throw new Error("usage: proxy-up.mjs <port> <bearer-file> [network] [image] [label-prefix]");
const bearer = ensure(bearerFile);
const policy = await loadPolicy();
const log = e => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), refused: true, ...e }) + "\n");
const server = createProxy({ socket: "/var/run/docker.sock", policy, config: { network, image, labelPrefix, capAdd: [] }, bearer, log });
server.listen(Number(port), "127.0.0.1", () => process.stderr.write(JSON.stringify({ listening: Number(port), network, image, labelPrefix }) + "\n"));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
