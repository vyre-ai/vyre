// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { personRelayReportMarkdown } from "./person-relay-report.js";
import { listAllPersonRelayEntryPoints } from "./person-relay-entrypoints.js";

test("person relay report lists every derived entry point", () => {
  const fake = { tools: { has: (n) => !n.startsWith("stream.send-group") } };
  const md = personRelayReportMarkdown(fake);
  const eps = listAllPersonRelayEntryPoints(fake);
  for (const e of eps) assert.match(md, new RegExp(e.id.replace(/\./g, "\\.")));
  assert.match(md, /composer\.slash/);
  assert.match(md, /RELAY_ALLOWED/);
});
