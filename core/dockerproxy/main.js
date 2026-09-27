// @ts-check
// The docker-api service's entry (box/compose.yml): the real policy, the box's computers config
// from the environment, and the proxy on 0.0.0.0:2375 of an internal network only vyred's
// namespace joins. Not a vyred module: there is no module.json here, on purpose.

import { createProxy, loadPolicy } from "./proxy.js";
import { read as readBearer } from "../../lib/bearer/index.js";

const env = process.env;
const config = {
  network: env.VYRE_COMPUTERS_NETWORK || "vyre-computers",
  image: env.VYRE_COMPUTERS_IMAGE || "vyre/computer:0.1",
  labelPrefix: env.VYRE_COMPUTERS_LABEL_PREFIX || "run.vyre.computers",
  capAdd: (env.VYRE_COMPUTERS_CAP_ADD || "").split(",").map(s => s.trim()).filter(Boolean),
};
const socket = env.DOCKER_SOCKET || "/var/run/docker.sock";
const port = Number(env.VYRE_DOCKER_PROXY_PORT || 2375);

// vyred generates this (bearer.js's ensure()) in a volume only the two of them share; retry a
// while in case this container is up before vyred's first boot has written it.
const bearerFile = env.DOCKER_PROXY_BEARER_FILE;
if (!bearerFile) throw new Error("DOCKER_PROXY_BEARER_FILE is not set -- refusing to run with no bearer");
const bearer = await readBearer(bearerFile);

const policy = await loadPolicy();
// Refusals only, and never a body: a create body carries the computer's passwords.
const log = entry => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), refused: true, ...entry }) + "\n");
const server = createProxy({ socket, policy, config, bearer, log });
server.listen(port, "0.0.0.0", () => {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), listening: port, socket, ...config }) + "\n");
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
