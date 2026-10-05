// What does this Twenty's metadata API let us set on a field and an object besides the name, label and kind (icon, position, description)? Run inside the Space's network (see conformance-live.sh).
import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
for (const n of ["CreateFieldInput", "UpdateFieldInput", "Field", "UpdateObjectPayload", "CreateObjectInput"]) {
  const r = await client.gql("metadata", `query { __type(name: "${n}") { inputFields { name type { name kind ofType { name } } } fields { name } } }`);
  const t = r.__type; console.log(n, ((t && (t.inputFields || t.fields)) || []).map((f) => f.name).join(" "));
}
