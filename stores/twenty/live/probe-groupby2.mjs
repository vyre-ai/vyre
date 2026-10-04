// Try Twenty's native group-by on real data: a select, a number, a date, an ungrouped total, a filter, a money field. Prints raw answers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { mintUuid } from "../../../kernel/core/ids.js";

const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const store = createTwentyStore({ client, space: "probe", dir: fs.mkdtempSync(path.join(os.tmpdir(), "probe-")), webhookSecret: "x", graceMs: 0 });
await store.define({ add_types: [{ name: "deal", label: "Deal", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "choice", label: "Stage", options: ["new", "won", "lost"] }, { name: "size", kind: "number", label: "Size" }, { name: "fee", kind: "money", label: "Fee" }, { name: "closed", kind: "date", label: "Closed" }, { name: "who", kind: "link", label: "Who" }] }] });
const rows = [["new", 10, 100, "2026-01-02"], ["new", 20, 50, "2026-01-02"], ["won", 30, 70, "2026-02-03"], ["won", null, 0, null], ["lost", 5, 5, "2026-02-03"]];
for (const [stage, size, amt, closed] of rows) await store.create("deal", mintUuid(), { title: "t", stage, ...(size === null ? {} : { size }), fee: { amount: amt, currency: "USD" }, ...(closed ? { closed } : {}), who: { urn: "vyre://s/c/" + stage } });
const q = async (label, query, vars) => { try { console.log(label, JSON.stringify(await client.gql("graphql", query, vars))); } catch (e) { console.log(label, "ERR", String(e.message).slice(0, 240)); } };
await q("by stage", `query { dealsGroupBy(groupBy: [{ stage: true }]) { groupByDimensionValues totalCount sumSize avgSize minSize maxSize countNotEmptySize } }`);
await q("by stage+filter", `query($f: DealFilterInput) { dealsGroupBy(groupBy: [{ stage: true }], filter: $f) { groupByDimensionValues totalCount } }`, { f: { size: { gt: 6 } } });
await q("by who", `query { dealsGroupBy(groupBy: [{ who: true }]) { groupByDimensionValues totalCount } }`);
await q("by closed day", `query { dealsGroupBy(groupBy: [{ closed: { granularity: DAY } }]) { groupByDimensionValues totalCount } }`);
await q("by closed (bare)", `query { dealsGroupBy(groupBy: [{ closed: true }]) { groupByDimensionValues totalCount } }`);
await q("ungrouped: empty list", `query { dealsGroupBy(groupBy: []) { groupByDimensionValues totalCount sumSize } }`);
await q("ungrouped: deletedAt", `query { dealsGroupBy(groupBy: [{ deletedAt: { granularity: DAY } }]) { groupByDimensionValues totalCount sumSize } }`);
await q("money fields", `query { dealsGroupBy(groupBy: [{ stage: true }]) { groupByDimensionValues totalCount sumFeeAmountMicros } }`);
await q("money fields 2", `query { dealsGroupBy(groupBy: [{ stage: true }]) { groupByDimensionValues totalCount sumFee { amountMicros } } }`);
await q("with deleted rows in play", `query($f: DealFilterInput) { dealsGroupBy(groupBy: [{ stage: true }], filter: $f) { groupByDimensionValues totalCount } }`, { f: { or: [{ deletedAt: { is: "NULL" } }, { deletedAt: { is: "NOT_NULL" } }] } });
await q("limit", `query { dealsGroupBy(groupBy: [{ stage: true }], limit: 1) { groupByDimensionValues totalCount } }`);
