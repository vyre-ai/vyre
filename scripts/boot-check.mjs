// boot-check: start a real vyred from the tree in a temp home and list modules that failed to start.
// Usage (on a test box, in the tree): VYRE_NO_DIALOGS=1 node boot-check.mjs [--kernel]
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const tree = process.cwd();
const { start } = await import(path.join(tree, "core/daemon/index.js"));
const { present } = await import(path.join(tree, "test/helpers.js"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootcheck-"));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box" }));
const d = await start({ root, presence: present, log: () => {} });
const st = d.registry.status();
const bad = st.filter(m => m.state === "failed");
const off = st.filter(m => m.state === "off").map(m => m.name);
console.log(`BOOT kernel=${process.env.VYRE_KERNEL || "0"} modules=${st.length} running=${st.length - bad.length} failed=${bad.length}`);
console.log("  off (not started on this box): " + off.join(", "));
for (const m of bad) console.log(`  ${m.state} ${m.name}: ${m.error || m.reason || ""}`);
await d.stop(); fs.rmSync(root, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
