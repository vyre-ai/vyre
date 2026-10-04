// What does Twenty's native group-by look like on this version? Prints the signature of `<plural>GroupBy` and the fields it returns for one object, then
// runs one against live data. Run in a container on the Space's network like probe-history.mjs.
import fs from "node:fs";
import { TwentyClient } from "../client.js";

const c = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const plural = process.argv[2] ?? "matters";
const show = (t) => (t.kind === "NON_NULL" ? show(t.ofType) + "!" : t.kind === "LIST" ? "[" + show(t.ofType) + "]" : t.name);
const sig = await c.gql("graphql", `query { __type(name: "Query") { fields { name args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name ofType { kind name } } } } } }`);
const f = sig.__type.fields.find((x) => x.name === `${plural}GroupBy`);
console.log(f ? `${f.name}(${f.args.map((a) => `${a.name}: ${show(a.type)}`).join(", ")}): ${show(f.type)}` : "no such field; available: " + sig.__type.fields.filter((x) => /GroupBy$/.test(x.name)).map((x) => x.name).join(", "));
if (f) {
  const tn = (function walk(t) { return t.name ?? walk(t.ofType); })(f.type);
  const t = await c.gql("graphql", `query { __type(name: "${tn}") { fields { name type { kind name ofType { kind name ofType { kind name } } } } } }`);
  console.log("returns:", t.__type.fields.map((x) => `${x.name}: ${show(x.type)}`).join(", "));
}
