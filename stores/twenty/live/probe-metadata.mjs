// What does this Twenty's metadata API offer for switching an object's timeline off? Run inside the Space's network (see conformance-live.sh).
import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const t = async (label, q) => { try { console.log(label, JSON.stringify(await client.gql("metadata", q)).slice(0, 700)); } catch (e) { console.log(label, "ERR", String(e.message).slice(0, 300)); } };
await t("CreateObjectInput", 'query { __type(name: "CreateObjectInput") { inputFields { name } } }');
await t("CreateObjectInput.object", 'query { __type(name: "CreateObjectInput") { name kind } }');
await t("UpdateObjectPayload", 'query { __type(name: "UpdateObjectPayload") { inputFields { name } } }');
await t("Object type", 'query { __type(name: "Object") { fields { name } } }');
await t("any isAudit", 'query { __schema { types { name inputFields { name } } } }');
