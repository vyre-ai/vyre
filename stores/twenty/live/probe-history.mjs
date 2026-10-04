// Where does a plain value live in a real Twenty after it is written, changed and nulled through the API? Run in a container on the Space's network
// (see conformance-live.sh for the wiring; this takes the same VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE) and then ask the database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { mintUuid } from "../../../kernel/core/ids.js";

const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const store = createTwentyStore({ client, space: "probe", dir: fs.mkdtempSync(path.join(os.tmpdir(), "probe-")), webhookSecret: "x", graceMs: 0 });
await store.define({ add_types: [{ name: "memo", label: "Memo", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "ssn", kind: "text", label: "Plain" }] }] });
const id = mintUuid();
let r = await store.create("memo", id, { title: "probe", ssn: "PLAINVALUE-123-45-6789" });
r = await store.update("memo", id, { ssn: "PLAINVALUE-CHANGED-987" }, r.version);
r = await store.update("memo", id, { ssn: null }, r.version);
console.log("written, changed, nulled; record now", JSON.stringify(r.data));
const log = JSON.stringify((await store.changes(null, 100)).entries);
console.log("plain value in the store's own change log:", log.includes("PLAINVALUE"));
