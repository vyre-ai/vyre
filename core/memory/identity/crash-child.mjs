// A vyred that seals the identity memory, is unlocked, learns a new fact, and then waits to be killed. Not a test: core/memory/identity/live.test.js runs it as a child and kills it with SIGKILL.
import fs from "node:fs";
import path from "node:path";
import { start } from "../../daemon/index.js";
import { configureYes } from "../../../lib/one-yes.js";
import { Phone } from "./home.js";

const root = process.argv[2];
const device = JSON.parse(process.env.CHILD_PHONE || "{}");
configureYes({ softwareOk: () => true, verify: async () => null });
const d = await start({ root, log: () => {} });
import { as } from "./test-facts.js";
const ask = (tool, input, caller = "cli") => as(d, tool, input, caller);
const must = async (tool, input, caller) => { const r = await ask(tool, input, caller); if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`); return r.data; };
await must("agents.create", { name: "juno", kind: "assistant" });
await must("memory.remember", { text: "I live in Lisbon and I use Postgres." });
await must("memory.identity.enroll", { devices: [{ publicJwk: device.publicJwk }] });
const server = JSON.parse(fs.readFileSync(path.join(root, "identity-server-key.json"), "utf8"));
const phone = new Phone(device);
phone.grant(server.publicJwk);
await must("memory.identity.grant", { proof: { signed: true } }, "mcp:agent:juno");
const { ask: a } = await must("memory.identity.unlock.begin", {}, "mcp:agent:juno");
await must("memory.identity.unlock.finish", { request: a.request, answer: phone.answer(a) }, "mcp:agent:juno");
await must("memory.remember", { text: "I prefer short emails." });
// wait for the facts to reach the disk as ciphertext (the autosave)
for (let i = 0; i < 100; i++) { const st = await must("memory.identity.status", {}, "mcp:agent:juno"); if (st.rev >= 2) break; await new Promise(r => setTimeout(r, 100)); }
process.stdout.write("READY\n");
setInterval(() => {}, 1 << 30);
