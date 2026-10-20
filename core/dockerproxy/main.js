// @ts-check
// The docker-api service's entry (box/compose.yml): the real policy, the box's computers config
// from the environment, and the proxy on 0.0.0.0:2375 of an internal network only vyred's
// namespace joins. Not a vyred module: there is no module.json here, on purpose.

import fs from "node:fs";
import { createProxy, loadPolicy } from "./proxy.js";
import { watch as watchBearer } from "../../lib/bearer/index.js";
import { computersFromEnv } from "../../lib/computers-env.js";

const env = process.env;
// The same VYRE_COMPUTERS_* values compose hands vyred (one anchor each in box/compose.yml), read by the same function, with the same defaults.
const config = computersFromEnv(env);
const socket = env.DOCKER_SOCKET || "/var/run/docker.sock";
const port = Number(env.VYRE_DOCKER_PROXY_PORT || 2375);

// vyred generates the bearer (lib/bearer ensure()) in a volume only the two of them share. The proxy listens at once and reads the file
// when a request comes: on a fresh box this container is often up before vyred has written it, and vyred writes a new one if it is ever
// lost, so neither order nor a lost file needs a restart here. Until the file is there every request is refused.
const bearerFile = env.DOCKER_PROXY_BEARER_FILE;
if (!bearerFile) throw new Error("DOCKER_PROXY_BEARER_FILE is not set -- refusing to run with no bearer");
const bearer = watchBearer(bearerFile);
if (!bearer.current()) process.stderr.write(JSON.stringify({ at: new Date().toISOString(), waiting: "no bearer yet: it is read again when vyred first asks" }) + "\n");

const policy = await loadPolicy();
// Refusals only, and never a body: a create body carries the computer's passwords.
const log = entry => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), refused: true, ...entry }) + "\n");
const server = createProxy({ socket, policy, config, bearer, log });
server.listen(port, "0.0.0.0", () => {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), listening: port, socket, bearer: fs.existsSync(bearerFile) ? "present" : "not yet", ...config }) + "\n");
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
