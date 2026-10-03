// Step 6 of the end-to-end walk against a real daemon: vyred started with the kernel on and VYRE_STORE=twenty, a Space whose
// records live in its own Twenty, a record with a sealed field written through the gateway and the sealing process, read back
// as the owner (a reference) and as a model (a placeholder), and the raw Twenty row and database checked for the plaintext.
//   VYRE_KERNEL=1 VYRE_STORE=twenty VYRE_SEAL_DEV=1 VYRE_KERNEL_PATH_RULE=1 node stores/twenty/live/daemon-live.mjs [keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { start } from "../../../core/daemon/index.js";
import { CONTACT } from "../../../kernel/conformance/suite.js";
import { nameOf } from "../space-store.js";
import { names } from "../provision.js";

process.env.VYRE_STORE = process.env.VYRE_STORE || "auto"; process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now(); const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const d = await start({ root, log: lap, kernel: true });
const k = d.kernel, id = k.id;
lap(`daemon up, space ${id.space}, store.json = ${fs.readFileSync(path.join(root, "kernel", "store.json"), "utf8")}`);
const owner = () => k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: process.pid, inside_model_process: false, capsule_verified: true });
const model = () => k.chains.fromFacts({ kind: "socket", surface: "mcp", uid: process.getuid(), pid: process.pid, inside_model_process: true });
const R = k.gateway.records;
try {
  await R.define(owner(), { add_types: [CONTACT] });
  const c = await R.create(owner(), "contact", { name: "Pat Harlow", email: "pat@example.test" });
  const put = await k.gateway.seal.put({ chain: owner(), record: c.urn, field: "ssn", class: "us-ssn", value: "123-45-6789" });
  const u = await R.update(owner(), "contact", c.id, { ssn: put.ref }, c.version);
  const asOwner = await R.get(owner(), "contact", c.id);
  console.log("owner reads ssn:", JSON.stringify(asOwner.data.ssn));
  const asModel = await R.get(model(), "contact", c.id).catch((e) => ({ refused: e.code }));
  console.log("model reads ssn:", JSON.stringify(asModel.data ? asModel.data.ssn : asModel));
  // the plaintext is nowhere in Twenty
  const proj = names(nameOf(id.space)).project;
  const dump = execFileSync("docker", ["compose", "-p", proj, "exec", "-T", "db", "pg_dump", "-U", "postgres", "default"], { cwd: path.join(root, "kernel", "twenty-home", "spaces", nameOf(id.space), "twenty"), maxBuffer: 1 << 28 }).toString();
  console.log("plaintext in the Twenty database:", dump.includes("123-45-6789"), "| reference in it:", dump.includes(put.ref.ref));
  const log = JSON.stringify(k.log ? k.log.read({}) : []);
  console.log("plaintext in the event log:", log.includes("123-45-6789"), "| audit:", JSON.stringify(await k.gateway.audit.verify()));
  console.log("types in this Space's Twenty:", (await k.store.types()).map((t) => t.name).join(", "));
  // a restart: the same Space, the same Twenty, the same record, the sealed field still a reference
  await d.stop();
  const d2 = await start({ root, log: lap, kernel: true });
  const k2 = d2.kernel;
  const o2 = k2.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: process.pid, inside_model_process: false, capsule_verified: true });
  const m2 = k2.chains.fromFacts({ kind: "socket", surface: "mcp", uid: process.getuid(), pid: process.pid, inside_model_process: true });
  const again = await k2.gateway.records.get(o2, "contact", c.id);
  const againModel = await k2.gateway.records.get(m2, "contact", c.id).catch((e) => ({ refused: e.code }));
  console.log("after restart: same Space", k2.id.space === id.space, "| owner reads", JSON.stringify(again.data.ssn), "| model reads", JSON.stringify(againModel.data ? againModel.data.ssn : againModel), "| audit", JSON.stringify(await k2.gateway.audit.verify()));
  await d2.stop();
  lap("done");
} finally {
  await d.stop().catch(() => {});
  if (process.argv[2] !== "keep") {
    const dir = path.join(root, "kernel");
    execFileSync("docker", ["compose", "-p", names(nameOf(id.space)).project, "down", "-v"], { cwd: path.join(dir, "twenty-home", "spaces", nameOf(id.space), "twenty") });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
