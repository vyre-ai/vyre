// The template tools answered from memory, for the sample build (EXPO_PUBLIC_VYRE_MOCK=1) only: a Matter and a Campaign template, live, and a draft; what a person makes or changes stays for the session.
// The shapes are the box's own (core/work/templates.js shape and list), so the screens run the same code against it.
type V = { template: string; version: number; name: string; state: "draft" | "live" | "retired"; owner: string; tags: string[]; note?: string; body: any };

const task = (title: string, doer: string, extra: any = {}) => ({ title, doer, output: { kind: "note" }, ...extra });
const DAY = 86_400_000;
const MATTER = {
  name: "Estate plan", noun: { one: "Matter", many: "Matters" }, description: "From the first call to the signed documents.", tags: ["estate"],
  roles: [{ role: "attorney", lead: true }, { role: "paralegal" }],
  stages: [
    { name: "Opening", owner: "role:attorney", groups: [{ name: "Documents" }, { name: "Client calls" }], tasks: [
      task("Run the conflict check", "role:paralegal", { due_offset_ms: 1 * DAY, group: "Documents" }),
      task("Sign the engagement letter", "role:attorney", { output: { kind: "decision" }, due_offset_ms: 3 * DAY, group: "Documents" }),
      task("Write the welcome email to the family", "teammate:research", { needs_yes: ["sending anything to the family"], due_offset_ms: 2 * DAY, group: "Client calls", required: false }),
    ] },
    { name: "Initial Administration", done_when: "all", tasks: [
      task("Gather the family's documents", "role:paralegal", { due_offset_ms: 7 * DAY }),
      task("Open the estate file", "lead", { due_offset_ms: 2 * DAY }),
    ] },
    { name: "Inventory", done_when: "sign_off", sign_off: "role:attorney", tasks: [
      task("List assets and debts", "teammate:research", { due_offset_ms: 14 * DAY }),
      task("Review the inventory", "role:attorney", { output: { kind: "decision" }, due_offset_ms: 5 * DAY }),
    ] },
    { name: "Ongoing Administration", tasks: [task("Send the quarterly update to the family", "lead")] },
    { name: "Closing" },
  ],
};
const CAMPAIGN = {
  name: "Ad campaign", stage_mode: "any", noun: { one: "Campaign", many: "Campaigns" }, description: "A paid campaign from brief to report.", tags: ["marketing"],
  roles: [{ role: "strategist", lead: true }, { role: "designer" }],
  stages: [
    { name: "Brief", tasks: [task("Write the brief", "role:strategist")] },
    { name: "Creative", tasks: [task("Make three ad designs", "role:designer"), task("Approve the designs", "role:strategist", { output: { kind: "decision" } })] },
    { name: "Live", tasks: [task("Check spend each week", "role:strategist")] },
    { name: "Report" },
  ],
};
const ATP = {
  name: "ATP (AI Transformation Partnership)", noun: { one: "ATP client", many: "ATP clients" }, description: "A client's first ninety days of AI work with us.", tags: ["atp"],
  roles: [{ role: "consultant" }, { role: "intake" }],
  stages: [
    { name: "Intake", done_when: "all", tasks: [task("Book the kickoff call", "role:intake", { due_offset_ms: 1 * DAY }), task("Collect the client's tools and logins", "person:alex", { due_offset_ms: 3 * DAY }), task("Research the client's firm and market", "teammate:research", { due_offset_ms: 2 * DAY })] },
    { name: "Audit", done_when: "sign_off", sign_off: "person:alex", tasks: [task("Map how the firm works today", "role:consultant", { due_offset_ms: 7 * DAY }), task("Agree the first three automations", "lead", { output: { kind: "decision" }, due_offset_ms: 10 * DAY })] },
    { name: "Build", tasks: [task("Build the first automation", "teammate:research", { needs_yes: ["turning anything on for the client"], due_offset_ms: 21 * DAY }), task("Review it with the client", "lead", { due_offset_ms: 25 * DAY, required: false })] },
    { name: "Handover", tasks: [task("Train the client's team", "role:consultant", { due_offset_ms: 5 * DAY })] },
  ],
};
const DRAFT = { name: "Client onboarding", description: "What happens in a new client's first week.", stages: [{ name: "Welcome", tasks: [task("Send the welcome email", "role:owner")] }, { name: "Done" }] };

const db: V[] = [
  { template: "tpl_estate-plan", version: 2, name: "Estate plan", state: "live", owner: "per_you", tags: ["estate"], body: MATTER },
  { template: "tpl_estate-plan", version: 1, name: "Estate plan", state: "retired", owner: "per_you", tags: ["estate"], body: { ...MATTER, noun: undefined } },
  { template: "tpl_ad-campaign", version: 1, name: "Ad campaign", state: "live", owner: "per_you", tags: ["marketing"], body: CAMPAIGN },
  { template: "tpl_atp", version: 1, name: ATP.name, state: "live", owner: "per_you", tags: ["atp"], body: ATP },
  { template: "tpl_client-onboarding", version: 1, name: "Client onboarding", state: "draft", owner: "per_you", tags: [], body: DRAFT },
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
const shape = (v: V, withBody = false) => ({ template: v.template, version: v.version, name: v.name, state: v.state, owner: v.owner, tags: v.tags, ...(v.note ? { note: v.note } : {}), ...(withBody ? { body: v.body } : {}) });
const versionsOf = (t: string) => db.filter((v) => v.template === t).sort((a, b) => b.version - a.version);
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export const mockTools: Record<string, (i: any) => unknown> = {
  "work.template.list": (i) => {
    if (i.template) return { template: i.template, versions: versionsOf(i.template).map((v) => shape(v)) };
    const ids = [...new Set(db.map((v) => v.template))].sort();
    return { templates: ids.map((id) => { const vs = versionsOf(id); const live = vs.find((v) => v.state === "live"); return { template: id, name: vs[0].name, live: live ? live.version : null, latest: vs[0].version, versions: vs.length, owner: vs[0].owner, tags: vs[0].tags, noun: vs[0].body.noun, archived: vs.every((v) => v.state === "retired") }; }) };
  },
  "work.template.get": (i) => { const vs = versionsOf(i.template); const v = i.version ? vs.find((x) => x.version === i.version) : vs.find((x) => x.state === "live") || vs[0]; if (!v) throw fail("not_found", `no template ${i.template}`); return shape(v, true); },
  "work.template.define": (i) => {
    const body = typeof i.body === "string" ? JSON.parse(i.body) : i.body;
    if (!String(body.name || "").trim()) throw fail("bad_input", "that template is not valid: name the template");
    const id = i.template || `tpl_${slug(body.name)}`; const have = versionsOf(id);
    const v: V = { template: id, version: (have[0]?.version || 0) + 1, name: body.name, state: "draft", owner: "per_you", tags: body.tags || [], note: i.note, body: JSON.parse(JSON.stringify(body)) };
    db.push(v); return shape(v);
  },
  "work.template.golive": (i) => { const vs = versionsOf(i.template); const v = vs.find((x) => x.version === i.version)!; vs.forEach((x) => { if (x.state === "live") x.state = "retired"; }); v.state = "live"; return shape(v); },
  "work.template.test": (i) => { const v = versionsOf(i.template).find((x) => x.version === i.version)!; return { ok: true, lines: v.body.stages.flatMap((s: any, n: number) => [`Stage ${n + 1}: ${s.name}`, ...(s.tasks || []).map((t: any) => `  ${t.title} (${t.doer})`)]), totals: `${v.body.stages.length} stages` }; },
  "work.template.library": () => ({ templates: [] }),
  "work.template.from-project": (i) => mockTools["work.template.define"]({ body: { ...MATTER, name: `${i.name || "Rivera Family Trust"} (copy)` }, note: "made from a project" }),
  "work.start-project": (i) => { const v = versionsOf(i.template).find((x) => x.state === "live"); if (!v) throw fail("bad_state", "that template has no live version: put a version live first"); return { project: `vyre://mock/project/${slug(i.name)}`, slug: slug(i.name), template: i.template, version: v.version, stage: v.body.stages[0].name, teammates: [], tasks_made: (v.body.stages[0].tasks || []).length }; },
  "flows.list": () => ({ flows: [] }),
  "agents.list": () => [{ name: "research", label: "Research" }, { name: "scribe", label: "Scribe" }],
};
