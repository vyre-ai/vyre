// A walk of the Store adapter against a real vyred, without a device: each Store call goes out through `vyre call` (the cli caller, so human-only
// calls answer needs_presence, which is printed as it is). Run on a test box against the dev vyred, with that vyred's HOME exported:
//   VYRE_BIN="node bin/vyre" node deck/ui/dev/real-walk.mjs [contactType]
// Prints one line per Store call: what it asked and what came back, or the error code and words.
import { spawnSync } from "node:child_process";
import { createGatewayStore, storeError } from "../gateway-adapter.js";

const bin = (process.env.VYRE_BIN || "node bin/vyre").split(" ");
function run(tool, input) {
  const r = spawnSync(bin[0], [...bin.slice(1), "call", tool, JSON.stringify(input ?? {})], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (r.status === 0) { try { return JSON.parse(out); } catch { return out; } }
  const m = /^\s*([a-z_]+):\s*(.*)$/m.exec(r.stderr || r.stdout || "");
  throw storeError({ code: m?.[1], message: m?.[2] || (r.stderr || "failed").trim() });
}
const rpc = { read: async (t, i) => run(t, i), write: async (t, i) => run(t, i) };
const store = createGatewayStore({ rpc });
const show = (v) => JSON.stringify(v)?.slice(0, 160);
const step = async (name, f) => { try { console.log("ok  ", name, show(await f())); } catch (e) { console.log("FAIL", name, `${e.code}: ${e.message}`); } };

const type = process.argv[2] || "contact";
await step("me", () => store.me());
await step("spaces", () => store.spaces());
await step("actors", () => store.actors());
await step("types", async () => (await store.types()).map((t) => t.name));
let rows = [];
await step(`list ${type}`, async () => (rows = await store.list(type)).length);
if (rows[0]) {
  const urn = rows[0].urn;
  await step("get", () => store.get(urn));
  await step("update (title append)", async () => { const r = await store.get(urn); return store.update(urn, { name: `${r.data?.name ?? "x"}` }, r.version); });
  await step("sees as assistant", () => store.seesAs(urn, "assistant"));
}
await step("tasks", async () => (await store.tasks()).map((t) => [t.id, t.state, t.title]));
await step("events", async () => (await store.events({ limit: 5 })).length);
