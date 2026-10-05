import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
for (const n of ["CreateViewInput", "View", "ViewGroup", "ViewFilter", "ViewCalendarLayout", "ViewFilterGroupLogicalOperator"]) {
  const r = await client.gql("metadata", `query { __type(name: "${n}") { inputFields { name type { name kind ofType { name } } } fields { name } enumValues { name } } }`);
  const t = r.__type;
  console.log(n, (t.inputFields || t.fields || t.enumValues).map((f) => f.name + (f.type ? ":" + (f.type.name || f.type.ofType?.name) : "")).join(" "));
}
