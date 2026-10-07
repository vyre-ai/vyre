// @ts-check
// DEVELOPMENT ONLY: `records.dev-seed`, the walk's seed. It exists only while the presence stand-in is on (a development build whose home holds the owner's hand-made
// `dev-presence-stand-in`); otherwise it answers dev_only and does nothing. It makes the types, records and tasks the app's screens need on a box with no data: contact and matter types (matter is
// a project with a stage), three contacts (one with a sealed SSN), four matters, and two tasks (one waiting for the person's check, one an assistant is working). Everything goes through the
// same gateway calls the real tools use, under the caller's own chain; the approval task is brought to `needs_check` by the assistant's own session chain, as in real use.
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

export const CONTACT_TYPE = Object.freeze({
  name: "contact", label: "Contact", icon: "person",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true },
    { name: "email", kind: "text", label: "Email" },
    { name: "phone", kind: "text", label: "Phone" },
    { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } },
  ],
});
export const MATTER_TYPE = Object.freeze({
  name: "matter", label: "Matter", icon: "briefcase", kind: "project",
  fields: [
    { name: "title", kind: "text", label: "Title", required: true },
    { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Drafting", "Review", "Closed"] },
    { name: "client", kind: "link", label: "Client", to: "contact" },
    { name: "fee", kind: "money", label: "Fee" },
  ],
  stages: [{ name: "Intake" }, { name: "Drafting" }, { name: "Review" }, { name: "Closed" }],
});

/**
 * @param {{ gateway: any, surfaces: any, chain: any, space: string }} d @returns {Promise<any>}
 */
export async function seed(d) {
  const { gateway: gw, surfaces, chain, space } = d;
  const me = chain.hops[0].actor.id;
  await gw.records.define(chain, { add_types: [CONTACT_TYPE, MATTER_TYPE] }).catch((/** @type {any} */ e) => { if (e && e.code !== "invalid") throw e; });
  // Idempotent: a record or task that is already there (by name or title) is reused, so a second run adds only what is missing.
  const rowsOf = async (/** @type {string} */ type) => {
    /** @type {any[]} */ const out = []; let cursor;
    for (let i = 0; i < 10; i++) {
      const p = await gw.records.query(chain, type, { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      out.push(...p.rows); if (!p.next_cursor) break; cursor = p.next_cursor;
    }
    return out.map((/** @type {any} */ r) => ({ ...r, urn: r.urn || `vyre://${space}/${type}/${r.id}` }));
  };
  const haveContacts = await rowsOf("contact"), haveMatters = await rowsOf("matter");
  const people = [["Jane Doe", "jane@harlowlegal.test", "555-0101"], ["Marcus Hale", "marcus@northwind.test", "555-0102"], ["Priya Raman", "priya@juno.test", "555-0103"]];
  /** @type {any[]} */ const contacts = [];
  for (const [name, email, phone] of people) {
    const was = haveContacts.find((/** @type {any} */ r) => r.data && r.data.name === name);
    if (was) { contacts.push(was); continue; }
    const c = await gw.records.create(chain, "contact", { name, email, phone });
    contacts.push(c);
    // one sealed value: the plaintext goes to the sealing process, the record keeps the reference
    if (gw.seal && name === people[0][0]) {
      const put = await gw.seal.put(chain, { record: c.urn, field: "ssn", class: "us-ssn", value: "123-45-6789" });
      await gw.records.update(chain, "contact", c.id, { ssn: put && put.ref ? put.ref : put }, c.version);
    }
  }
  const matters = [["Doe estate plan", "Intake", 0, 4200], ["Hale trust amendment", "Drafting", 1, 1800], ["Raman probate", "Review", 2, 9500], ["Doe guardianship", "Closed", 0, 3000]];
  /** @type {any[]} */ const made = [];
  for (const [title, stage, who, fee] of matters) {
    const was = haveMatters.find((/** @type {any} */ r) => r.data && r.data.title === title);
    made.push(was || await gw.records.create(chain, "matter", { title, stage, client: { urn: contacts[/** @type {number} */ (who)].urn }, fee: { amount: fee, currency: "USD" } }));
  }
  const assistant = { kind: "agent", id: "assistant", space };
  const person = { kind: "person", id: me, space };
  const haveTasks = await gw.ask.list(chain, {});
  const approvalTitle = "Should we take on the Doe guardianship matter?", doingTitle = "Summarise Hale trust amendment for the file";
  /** @type {any} */ let approval = haveTasks.find((/** @type {any} */ t) => t.title === approvalTitle), doing = haveTasks.find((/** @type {any} */ t) => t.title === doingTitle);
  // a task waiting for the person: the assistant reaches a decision and the person checks it (a send would need an outward grant this Space has not been given)
  if (!approval) {
    approval = await gw.ask.request(chain, { title: approvalTitle, doer: assistant, checker: person, output: { kind: "decision" }, record: made[0].urn });
    const s1 = await surfaces.open(chain, { agent: "assistant", ttl_ms: 60_000 });
    try {
      const ac = await surfaces.chainFor(s1.token);
      await gw.ask.start(ac, approval.id);
      await gw.ask.complete(ac, approval.id, { answer: "yes", reason: "The conflict check is clear and the fee agreement matches the Doe estate plan." });
    } finally { surfaces.revoke(s1.session); }
  }
  // a plain task the assistant is working on
  if (!doing) {
    doing = await gw.ask.request(chain, { title: doingTitle, doer: assistant, output: { kind: "note" }, record: made[1].urn });
    const s2 = await surfaces.open(chain, { agent: "assistant", ttl_ms: 60_000 });
    try { await gw.ask.start(await surfaces.chainFor(s2.token), doing.id); } finally { surfaces.revoke(s2.session); }
  }
  return { space, person: me, contacts: contacts.map(c => c.urn), matters: made.map(m => m.urn), tasks: { approval: approval.id, doing: doing.id } };
}

/** @param {any} ctx @param {{ open: (input: any, meta: any) => Promise<any> }} door @param {() => boolean} devOn */
export function registerDevSeed(ctx, door, devOn) {
  ctx.tool("records.dev-seed", {
    description: "DEVELOPMENT ONLY, while the presence stand-in is on: seed a Space with the walk's types, records and tasks. Otherwise it does nothing.",
    input: { type: "object", properties: { space: { type: "string" } } }, callers: ["cli", "local"],
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (!devOn()) throw refuse("this is a development tool: it runs only while the presence stand-in is on", "dev_only");
      return seed(await door.open(i || {}, meta));
    },
  });
}
