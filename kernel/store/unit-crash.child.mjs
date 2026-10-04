// The child of kernel/store/unit-of-work.test.js: a kernel on a file database, one record written and acknowledged, then a second write killed (SIGKILL) at the moment its event is inserted,
// that is, after the record's own change was written and before anything committed.
import { DatabaseSync } from "node:sqlite";
import { bootKernel } from "../boot.js";
import { CONTACT } from "../conformance/suite.js";

const [file] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
db.function("die", () => { process.kill(process.pid, "SIGKILL"); return 0; });
const SPACE = "spc_crashtest001", OWNER = "per_owner";
const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
await k.gateway.records.define(chain, { add_types: [CONTACT] });
const a = await k.gateway.records.create(chain, "contact", { name: "Acknowledged" });
process.stdout.write(`acked ${a.id}\n`);
// from here, an event insert for a contact kills the process
db.exec("CREATE TRIGGER kill_on_event BEFORE INSERT ON kernel_events WHEN new.type = 'contact.created' BEGIN SELECT die(); END");
await k.gateway.records.create(chain, "contact", { name: "Never acknowledged" });
process.stdout.write("survived\n");
