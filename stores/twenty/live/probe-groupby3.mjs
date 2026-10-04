import fs from "node:fs";
import { TwentyClient } from "../client.js";
const client = new TwentyClient({ url: process.env.VYRE_TWENTY_LIVE_URL, key: () => fs.readFileSync(process.env.VYRE_TWENTY_LIVE_KEY_FILE, "utf8").trim() });
const q = async (label, query, vars) => { try { console.log(label, JSON.stringify(await client.gql("graphql", query, vars))); } catch (e) { console.log(label, "ERR", String(e.message).slice(0, 300)); } };
await q("money agg", `query { dealsGroupBy(groupBy: [{ stage: true }]) { groupByDimensionValues totalCount countNotEmptyFee minFeeAmountMicros maxFeeAmountMicros avgFeeAmountMicros sumFeeAmountMicros } }`);
await q("by size (number)", `query { dealsGroupBy(groupBy: [{ size: true }]) { groupByDimensionValues totalCount } }`);
await q("two dims", `query { dealsGroupBy(groupBy: [{ stage: true }, { closed: true }]) { groupByDimensionValues totalCount } }`);
await q("title empty?", `query { dealsGroupBy(groupBy: [{ title: true }]) { groupByDimensionValues totalCount } }`);
await q("countNotEmptyClosed", `query { dealsGroupBy(groupBy: [{ stage: true }]) { groupByDimensionValues countNotEmptyClosed minClosed maxClosed } }`);
