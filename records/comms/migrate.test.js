import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import { migrateParticipants } from "./migrate.js";

const SPACE = "spc_harlow000001";
// the Participant type as a Space made before it was dropped still has it
const PARTICIPANT = { name: "participant", label: "Participant", fields: [
  { name: "communication", kind: "link", label: "Communication", to: "communication", required: true }, { name: "contact", kind: "link", label: "Contact", to: "contact" },
  { name: "address", kind: "text", label: "Address as written" }, { name: "how", kind: "choice", label: "How", options: ["from", "to", "cc", "bcc", "attendee", "organizer", "caller", "callee"], required: true } ] };

test("participants of an older Space move onto their communication once: the role and address into its text, the matched contact into `contacts`, then the participant records are gone", async () => {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  const R = host.kernel.records, c = host.ownerChain();
  await R.define(c, { add_types: [PARTICIPANT] });
  const jane = await R.create(c, "contact", { name: "Jane Doe", email: "jane@client.test" });
  const mail = await R.create(c, "communication", { kind: "email", at: "2026-10-01T09:00:00.000Z", source_key: "gmail:old1", subject: "Hello" });
  const meet = await R.create(c, "communication", { kind: "meeting", at: "2026-10-02T09:00:00.000Z", source_key: "gcal:old2" });
  const mk = (comm, how, address, contact) => R.create(c, "participant", { communication: { urn: comm.urn }, how, address, ...(contact ? { contact: { urn: contact.urn } } : {}) });
  await mk(mail, "from", "jane@client.test", jane); await mk(mail, "to", "alex@harlow.test"); await mk(mail, "to", "bob@firm.test"); await mk(mail, "cc", "stranger@elsewhere.test");
  await mk(meet, "organizer", "alex@harlow.test"); await mk(meet, "attendee", "jane@client.test", jane);
  const done = await migrateParticipants(host.kernel, c);
  assert.deepEqual(done, { migrated: 6, communications: 2 });
  const m1 = (await R.get(c, "communication", mail.id)).data, m2 = (await R.get(c, "communication", meet.id)).data;
  assert.deepEqual([m1.from, m1.to, m1.cc], ["jane@client.test", "alex@harlow.test, bob@firm.test", "stranger@elsewhere.test"], "every role and address survives, matched or not");
  assert.deepEqual(m1.contacts.map((x) => x.urn), [jane.urn]);
  assert.deepEqual([m2.organizer, m2.attendees], ["alex@harlow.test", "jane@client.test"]);
  assert.deepEqual(m2.contacts.map((x) => x.urn), [jane.urn]);
  assert.equal((await R.query(c, "participant", { page: { limit: 50 } })).rows.length, 0, "the participant records are removed");
  // once: a second look finds nothing, and what is on the communication is not repeated
  assert.deepEqual(await migrateParticipants(host.kernel, c), { migrated: 0, communications: 0 });
  assert.equal((await R.get(c, "communication", mail.id)).data.to, "alex@harlow.test, bob@firm.test");
});

test("a Space that never had the participant type has nothing to move", async () => {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  assert.deepEqual(await migrateParticipants(host.kernel, host.ownerChain()), { migrated: 0, communications: 0 });
});
