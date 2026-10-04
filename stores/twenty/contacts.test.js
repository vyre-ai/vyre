// The contacts block on the Twenty store (over the fake Twenty): the same cases that run on the built-in store.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { FakeTwenty } from "./testing/fake-twenty.js";
import { TwentyClient } from "./client.js";
import { createTwentyStore } from "./store.js";
import { contactsSuite } from "../../records/contacts/suite.js";

const dirs = [];
const fake = await new FakeTwenty().start();
after(async () => { await fake.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

contactsSuite(async () => {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "tw-contacts-")); dirs.push(dir);
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const store = createTwentyStore({ client, space: "harlow", dir, webhookSecret: crypto.randomBytes(16).toString("hex"), graceMs: 0 });
  fake.deliver = async (payload, headers, raw) => { await store.handleWebhook(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), raw); };
  await store.registerWebhook("fn:store");
  return store;
}, { test, assert }, "twenty (fake twenty)");

