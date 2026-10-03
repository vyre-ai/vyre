// A probe against a real Twenty for things the fake cannot tell us. Provisions (or reuses) a Space in a kept home, defines a type, and runs the probe named.
//   node stores/twenty/spike/probe-live.mjs <home dir> <space> <groupby|unique|worker> 
import fs from "node:fs";
import path from "node:path";
import { provisionSpace, spaceDir, realRunner } from "../provision.js";
import { TwentyClient } from "../client.js";
import { createTwentyStore } from "../store.js";
import { ACCOUNT, CONTACT } from "../../../kernel/conformance/suite.js";
import { mintUuid } from "../../../kernel/core/ids.js";

const [home, space, what] = process.argv.slice(2);
fs.mkdirSync(home, { recursive: true });
const t0 = Date.now(); const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), memory: process.env.MEM ?? "small", log: lap });
const client = new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() });
const store = createTwentyStore({ space, client, dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
await store.define({ add_types: [CONTACT, ACCOUNT] });

if (what === "groupby") {
  const q = await client.gql("graphql", `query { __type(name: "Query") { fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } } } }`);
  for (const f of q.__type.fields.filter((x) => /GroupBy$/.test(x.name) && /contact|account/i.test(x.name))) console.log(f.name, JSON.stringify(f.args.map((a) => [a.name, a.type.name ?? a.type.ofType?.name ?? a.type.ofType?.ofType?.name])));
  for (const n of ["ContactGroupByInput", "ContactGroupByDimension"]) { try { const t = await client.gql("graphql", `query { __type(name: "${n}") { name inputFields { name type { name kind } } } }`); console.log(n, JSON.stringify(t.__type)); } catch (e) { console.log(n, "err", e.message); } }
  for (let i = 0; i < 6; i++) await store.create("contact", mintUuid(), { name: `P${i}`, age: i % 2 ? 40 : 30, tags: [] }).catch((e) => console.log("create", e.message));
  for (const body of ["contactsGroupBy(groupBy: [{ age: true }]) { groupByDimensionValues totalCount }", "contactsGroupBy(groupBy: [{ age: true }]) { groupByDimensionValues }"]) {
    try { console.log(body, JSON.stringify(await client.gql("graphql", `query { ${body} }`))); } catch (e) { console.log(body, "ERR", e.message.slice(0, 300)); }
  }
}
if (what === "unique") {
  const mk = (n, h) => store.create("account", mintUuid(), { name: n, handle: h }).then((r) => ["ok", r.id], (e) => ["err", e.code, e.message.slice(0, 200)]);
  console.log("concurrent:", JSON.stringify(await Promise.all([mk("A", "h"), mk("B", "h"), mk("C", "h")])));
  const a = (await store.query("account", { page: { limit: 5 } })).rows[0];
  const b = await mk("D", "other");
  console.log("update into taken:", JSON.stringify(await store.update("account", b[1], { handle: "h" }, 1).then(() => "ok", (e) => [e.code, e.message.slice(0, 200)])));
  await store.remove("account", a.id, a.version);
  console.log("value freed after remove:", JSON.stringify(await mk("E", "h")));
  console.log("restore while taken:", JSON.stringify(await store.restore("account", a.id).then(() => "ok", (e) => [e.code, e.message.slice(0, 200)])));
}
console.log("HOME", home);
