// @ts-check
// The docker-api service's entry (box/compose.yml): the real policy, the box's computers config
// from the environment, and the proxy on 0.0.0.0:2375 of an internal network only vyred's
// namespace joins. Not a vyred module: there is no module.json here, on purpose.

import { createProxy, loadPolicy } from "./proxy.js";

const env = process.env;
const config = {
  network: env.VYRE_COMPUTERS_NETWORK || "vyre-computers",
  image: env.VYRE_COMPUTERS_IMAGE || "vyre/computer:0.1",
  labelPrefix: env.VYRE_COMPUTERS_LABEL_PREFIX || "run.vyre.computers",
  capAdd: (env.VYRE_COMPUTERS_CAP_ADD || "").split(",").map(s => s.trim()).filter(Boolean),
};
const socket = env.DOCKER_SOCKET || "/var/run/docker.sock";
const port = Number(env.VYRE_DOCKER_PROXY_PORT || 2375);

const policy = await loadPolicy();
// Refusals only, and never a body: a create body carries the computer's passwords.
const log = entry => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), refused: true, ...entry }) + "\n");
const server = createProxy({ socket, policy, config, log });
server.listen(port, "0.0.0.0", () => {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), listening: port, socket, ...config }) + "\n");
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
