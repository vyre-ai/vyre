// The child of the kept-counts crash test in kernel/store/sqlite.test.js: a stage changes, and the process is killed (SIGKILL) at the moment the kept count is about to be written,
// that is, after the record row and its change entry were written in the same transaction and before anything committed.
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "./sqlite.js";

const [file] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
db.function("die", () => { process.kill(process.pid, "SIGKILL"); return 0; });
const s = createSqliteStore({ db });
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }] };
await s.define({ add_types: [MATTER] });
const id = i => `0190c3f2-1111-4abc-8def-${String(i + 1).padStart(12, "0")}`;
for (let i = 0; i < 6; i++) await s.create("matter", id(i), { stage: i % 2 ? "open" : "intake" });
await s.aggregate("matter", { group_by: ["stage"], measures: [{ fn: "count" }] });   // builds the counts
db.exec("CREATE TRIGGER die_on_count BEFORE UPDATE ON kernel_counts BEGIN SELECT die(); END");
db.exec("CREATE TRIGGER die_on_count_insert BEFORE INSERT ON kernel_counts BEGIN SELECT die(); END");
const r = await s.get("matter", id(0));
process.stdout.write("changing\n");
await s.update("matter", id(0), { stage: "closed" }, r.version);
process.stdout.write("survived\n");
