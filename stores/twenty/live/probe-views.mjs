// What does this Twenty's metadata API offer for views (list, kanban, calendar, their fields, groups, filters and sorts)? Run inside the Space's network (see conformance-live.sh).
import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const q = async (label, query, vars) => { try { const r = await client.gql("metadata", query, vars); console.log(label, JSON.stringify(r)); return r; } catch (e) { console.log(label, "ERR", String(e.message).slice(0, 400)); } };
const names = await q("ops", 'query { __schema { queryType { fields { name } } mutationType { fields { name args { name type { name kind ofType { name kind } } } } } } }');
const viewOps = (names?.__schema.mutationType.fields || []).filter((f) => /view/i.test(f.name));
console.log("MUTATIONS", viewOps.map((f) => f.name).join(", "));
console.log("QUERIES", (names?.__schema.queryType.fields || []).filter((f) => /view/i.test(f.name)).map((f) => f.name).join(", "));
const types = await q("types", 'query { __schema { types { name kind } } }');
const typeNames = (types?.__schema.types || []).map((t) => t.name).filter((n) => /^(Create|Update|Delete)?(Core)?View/i.test(n) || /ViewType|ViewFilter|ViewSort|ViewGroup|ViewField|ViewOpen|ViewVis|ViewKey/i.test(n));
console.log("TYPES", typeNames.join(", "));
for (const n of typeNames.filter((x) => /Input|Enum|Type|Key|Visibility|Operand|Direction|Open/i.test(x)).slice(0, 60)) {
  await q(n, `query { __type(name: "${n}") { kind inputFields { name type { name kind ofType { name } } } enumValues { name } fields { name } } }`);
}
