import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const r = await client.gql("metadata", 'query { __schema { mutationType { fields { name args { name type { name kind ofType { name kind ofType { name } } } } type { name kind ofType { name } } } } queryType { fields { name args { name type { name kind ofType { name } } } } } } }');
const show = (f) => `${f.name}(${f.args.map((a) => a.name + ":" + (a.type.name || a.type.ofType?.name || a.type.ofType?.ofType?.name) + (a.type.kind === "NON_NULL" ? "!" : "")).join(", ")}) -> ${f.type?.name || f.type?.ofType?.name || ""}`;
for (const f of r.__schema.mutationType.fields.filter((f) => /^(create|destroy|delete)(View|ViewField|ViewFilter|ViewFilterGroup|ViewGroup|ViewSort|ManyViewFields|ManyViewGroups)$/.test(f.name))) console.log("M", show(f));
for (const f of r.__schema.queryType.fields.filter((f) => /^getView/.test(f.name))) console.log("Q", show(f));
