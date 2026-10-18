// @ts-check
// Sample data, so a new Space is not a blank page: a small made-up studio with people, companies, deals, a project, tasks and events, every record marked with the tag "sample". records.sample.add makes it (once),
// records.sample.remove takes every record of it away again (they go to the bin, so a mistake can be undone). A ledger row keeps the addresses of what was made, so nothing the person made themselves is ever removed.
// Nothing here is real and nothing in it names an industry.

export const SAMPLE_TAG = "sample";
export const LEDGER = "sample-ledger";
const tags = JSON.stringify([SAMPLE_TAG]);
const day = (/** @type {number} */ n, /** @type {number} */ now) => new Date(now + n * 86_400_000).toISOString().slice(0, 10);
const at = (/** @type {number} */ n, /** @type {number} */ h, /** @type {number} */ now) => `${day(n, now)}T${String(h).padStart(2, "0")}:00:00.000Z`;

/**
 * The records of the sample set, in the order they are made. A value "$key" names another record of the set, filled in with its address when it is made; { link: "$key" } is a link value.
 * @param {number} [now] @returns {{ key: string, type: string, data: Record<string, any> }[]}
 */
export function samplePlan(now = Date.now()) {
  const L = (/** @type {string} */ k) => ({ link: `$${k}` });
  return [
    { key: "northwind", type: "organization", data: { name: "Northwind", domain: "northwind.example", tags } },
    { key: "harbor", type: "organization", data: { name: "Harbor & Co", domain: "harborco.example", tags } },
    { key: "lumen", type: "organization", data: { name: "Lumen Works", domain: "lumenworks.example", tags } },
    { key: "ava", type: "contact", data: { name: "Ava Lindqvist", email: "ava@northwind.example", job_title: "Head of Brand", organization: L("northwind"), tags } },
    { key: "sam", type: "contact", data: { name: "Sam Okafor", email: "sam@harborco.example", job_title: "Founder", organization: L("harbor"), tags } },
    { key: "mira", type: "contact", data: { name: "Mira Holt", email: "mira@lumenworks.example", job_title: "Photographer", organization: L("lumen"), tags } },
    { key: "dev", type: "contact", data: { name: "Dev Rao", email: "dev@example.com", job_title: "Freelance writer", tags } },
    { key: "r_ava", type: "role-client", data: { holder: L("ava"), stage: "Active", since: day(-60, now) } },
    { key: "r_sam", type: "role-lead", data: { holder: L("sam"), stage: "Talking", since: day(-9, now) } },
    { key: "r_mira", type: "role-partner", data: { holder: L("mira") } },
    { key: "r_dev", type: "role-vendor", data: { holder: L("dev") } },
    { key: "r_northwind", type: "role-customer", data: { holder: L("northwind") } },
    { key: "d_rebrand", type: "deal", data: { name: "Northwind rebrand", organization: L("northwind"), contact: L("ava"), amount: 18000, probability: 100, weighted_value: 18000, close_date: day(-30, now), stage: "Won", tags } },
    { key: "d_launch", type: "deal", data: { name: "Harbor launch site", organization: L("harbor"), contact: L("sam"), amount: 9500, probability: 30, weighted_value: 2850, close_date: day(21, now), stage: "Qualified", tags } },
    { key: "d_lumen", type: "deal", data: { name: "Lumen photo series", organization: L("lumen"), contact: L("mira"), amount: 4200, probability: 10, weighted_value: 420, stage: "Lead", tags } },
    { key: "p_rebrand", type: "project", data: { name: "Northwind rebrand", slug: "sample-northwind-rebrand", status: "active", kind: "simple", client: L("ava"), due: day(30, now), tags } },
    { key: "t_one", type: "task", data: { title: "Send the warmer blue options to Ava", project: L("p_rebrand"), contact: L("ava"), due: at(2, 17, now), tags } },
    { key: "t_two", type: "task", data: { title: "Follow up with Sam about the launch site", contact: L("sam"), due: at(4, 17, now), tags } },
    { key: "t_three", type: "task", data: { title: "Book the photo shoot with Mira", contact: L("mira"), due: at(7, 17, now), tags } },
    { key: "e_review", type: "event", data: { title: "Brand review with Ava", starts_at: at(3, 10, now), ends_at: at(3, 11, now), source: "vyre", visibility: "space", tags } },
    { key: "e_shoot", type: "event", data: { title: "Photo shoot", starts_at: at(8, 9, now), ends_at: at(8, 13, now), place: "Studio", source: "vyre", visibility: "space", tags } },
    { key: "rel_ava", type: "relationship", data: { from_record: "$ava", to_record: "$northwind", kind: "Employee" } },
    { key: "rel_mira", type: "relationship", data: { from_record: "$mira", to_record: "$sam", kind: "Referrer" } },
  ];
}

/** A value with the set's own references filled in (a link becomes { urn }, a bare reference becomes the address). @param {any} v @param {Map<string, string>} made */
export function resolve(v, made) {
  if (typeof v === "string" && v.startsWith("$")) { const u = made.get(v.slice(1)); if (!u) throw new Error(`The sample set names ${v} before it is made.`); return u; }
  if (v && typeof v === "object" && typeof v.link === "string") return { urn: /** @type {string} */ (resolve(v.link, made)) };
  return v;
}

/** The ledger's addresses, back from its text; anything unreadable is none. @param {any} text */
export function urnsOf(text) {
  try { const a = JSON.parse(String(text || "[]")); return Array.isArray(a) ? a.filter((u) => typeof u === "string" && /^vyre:\/\/[^/]+\/[a-z][a-z0-9-]*\/[0-9a-f-]{36}$/.test(u)) : []; } catch { return []; }
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerSample({ tool, obj, str, refuse, parseUrn }) {
  const admin = (/** @type {any} */ d) => { let role = null; try { role = d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { /* none */ } if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin turns sample data on or off. Ask one of them.", "not_allowed"); };
  const ledger = async (/** @type {any} */ d) => ((await d.gateway.records.query(d.chain, LEDGER, { page: { limit: 1 } }).catch(() => ({ rows: [] }))).rows || [])[0] || null;

  tool("records.sample.add", "Fill the Space with made-up people, companies, deals, a project, tasks and events so there is something to look at. Each is tagged \"sample\"; records.sample.remove takes them away. Does nothing the second time. An owner's or admin's act. -> { added, skipped, already }.",
    obj({ space: str }), async (/** @type {any} */ _i, /** @type {any} */ d) => {
      admin(d);
      if (await ledger(d)) return { added: 0, skipped: 0, already: true };
      const defs = new Set(((await d.gateway.definitions(d.chain)) || []).map((/** @type {any} */ t) => t.name));
      /** @type {Map<string, string>} */ const made = new Map();
      const urns = [];
      let skipped = 0;
      for (const item of samplePlan()) {
        if (!defs.has(item.type)) { skipped++; continue; }
        try {
          const data = Object.fromEntries(Object.entries(item.data).map(([k, v]) => [k, resolve(v, made)]));
          // a field the type does not have is left out, so a Space that changed its types still gets the rest
          const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === item.type);
          const known = new Set((t.fields || []).map((/** @type {any} */ f) => f.name));
          const row = await d.gateway.records.create(d.chain, item.type, Object.fromEntries(Object.entries(data).filter(([k]) => known.has(k))));
          made.set(item.key, row.urn || `vyre://${d.space}/${item.type}/${row.id}`);
          urns.push(made.get(item.key));
        } catch { skipped++; }
      }
      if (urns.length) await d.gateway.records.create(d.chain, LEDGER, { urns: JSON.stringify(urns) });
      return { added: urns.length, skipped, already: false };
    });

  tool("records.sample.remove", "Take the sample data away: every record records.sample.add made, and nothing else. They go to the bin, so they can be brought back. An owner's or admin's act. -> { removed, already_gone }.",
    obj({ space: str }), async (/** @type {any} */ _i, /** @type {any} */ d) => {
      admin(d);
      const led = await ledger(d);
      if (!led) return { removed: 0, already_gone: 0 };
      let removed = 0, gone = 0;
      for (const urn of urnsOf(led.data.urns).reverse()) {
        const u = parseUrn(urn);
        try {
          const row = await d.gateway.records.get(d.chain, u.type, u.id);
          if (!row) { gone++; continue; }
          await d.gateway.records.remove(d.chain, u.type, u.id, row.version);
          removed++;
        } catch { gone++; }
      }
      await d.gateway.records.remove(d.chain, LEDGER, led.id, led.version).catch(() => {});
      return { removed, already_gone: gone };
    });
}
