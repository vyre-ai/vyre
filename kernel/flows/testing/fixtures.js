// Sample world for the Flow tests: Harlow Legal, a matter type with stages, and the registry actions the tests use.
export const SPACE = "spc_harlow000001";

export const catalog = () => ({
  space: SPACE,
  types: {
    matter: {
      name: "matter", label: "Matter",
      fields: [
        { name: "client", kind: "text", label: "Client" },
        { name: "plan", kind: "choice", label: "Plan", options: ["Will", "Trust", "Both"] },
        { name: "fee", kind: "money", label: "Fee" },
        { name: "email", kind: "text", label: "Email" },
        { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } },
        { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement", "Drafting"] },
      ],
      stages: [{ name: "Intake" }, { name: "Engagement" }, { name: "Drafting" }],
    },
    payment: { name: "payment", label: "Payment", fields: [{ name: "amount", kind: "number", label: "Amount" }, { name: "client", kind: "text", label: "Client" }] },
  },
  actions: {
    "email.send": { risk: "outward.send", label: "Send an email" },
    "email.draft": { risk: "write", label: "Draft an email" },
    "service.read": { risk: "read", label: "Read from a connected service" }, "service.call": { risk: "outward.send", label: "Call a connected service" },
    "records.read": { risk: "read" }, "records.create": { risk: "write" }, "records.update": { risk: "write" }, "records.remove": { risk: "outward.delete" },
  },
  roles: ["owner", "admin", "manager", "member", "attorney"],
  teammates: ["research", "intake"],
  templates: ["welcome"],
  // A connector is a vault credential and its route. No secret here: the catalog holds only which methods and paths the route allows.
  connectors: { practice: { allow: [{ method: "GET", path: "/matters/*" }, { method: "POST", path: "/matters" }, { method: "PUT", path: "/documents/*" }], deny: [{ path: "/admin/*" }] } },
});

/** A valid stored Flow touching most step kinds. */
export const onPayment = () => ({
  format: 1, name: "on_payment", label: "On payment", description: "A client pays: open a matter and ask for the engagement letter.",
  authorship: "human",
  trigger: { on: "event", event: "payment.received", where: "trigger.amount > 0" },
  steps: [
    { id: "open", kind: "create", type: "matter", set: { client: { expr: "trigger.client" }, stage: "Intake" } },
    { id: "who", kind: "find", type: "payment", where: "record.client == trigger.client", limit: 5 },
    { id: "big", kind: "decide", if: "len(steps.who.rows) > 1", then: [
      { id: "note", kind: "assign", to: "role:manager", title: "Repeat client", output: { kind: "note" } },
    ] },
    { id: "ok", kind: "ask", to: "role:attorney", title: { expr: "\"Send the engagement letter to \" + trigger.client + \"?\"" } },
  ],
});

/** A Kit in stored form, at a version. v2 adds an outward Flow, a sealed template slot and a role ability, so the update has widenings to name. */
export const estateKit = (version = 1) => ({
  format: 1, id: "estate-planning", version, name: "Estate planning", description: "Matters, a welcome email and the payment Flow.",
  includes: {
    types: [{
      name: "estate-matter", label: "Estate matter",
      fields: [{ name: "client", kind: "text", label: "Client" }, { name: "email", kind: "text", label: "Email" }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }],
      stages: [{ name: "Intake", tasks: [{ title: "Research the client", doer: "teammate:research", output: { kind: "fields", target: "practice_area" }, how: "assistant" }, { title: "Welcome email", doer: "teammate:intake", checker: "role:attorney", output: { kind: "sent" }, how: "tailor", template: "welcome", depends_on: ["Research the client"] }] }, { name: "Engagement" }],
    }],
    templates: [{ name: "welcome", kind: "email", body: version >= 2 ? "Dear {{client.name}}, your reference is {{sealed.ssn}}." : "Dear {{client.name}}, welcome." }],
    roles: [{ name: "intake_lead", base: "manager", abilities: version >= 2 ? ["projects.create_run", "kits.use"] : ["projects.create_run"] }],
    teammates: [{ name: "research", instructions: "Read about the client and write findings onto the matter." }, { name: "intake", instructions: version >= 2 ? "Draft the welcome email from the template, signing as Harlow Legal LLP." : "Draft the welcome email." }],
    flows: [
      { format: 1, name: "on_payment_estate", label: "On payment", authorship: "kit", trigger: { on: "event", event: "payment.received" }, steps: [{ id: "open", kind: "create", type: "estate-matter", set: { client: { expr: "trigger.client" }, stage: "Intake" } }] },
      ...(version >= 2 ? [{ format: 1, name: "weekly_digest", label: "Weekly digest", authorship: "kit", trigger: { on: "time", cron: "0 8 * * 1" }, steps: [{ id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "owner@example.com", body: "digest" } }] }] : []),
    ],
  },
});

/** The sample catalog with the matter's stages made of tasks, as an Estate planning Kit defines them. */
export const stagedCatalog = () => {
  const c = catalog();
  c.types.matter = { ...c.types.matter, fields: [...c.types.matter.fields.filter(f => f.name !== "stage"), { name: "practice_area", kind: "text", label: "Practice area" }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement", "Drafting", "Review", "Closed"] }],
    stages: [
      { name: "Intake", tasks: [
        { title: "Research the client", doer: "teammate:research", output: { kind: "fields", target: ["practice_area"] }, how: "assistant", due_offset_ms: 86_400_000 },
        { title: "Welcome email", doer: "teammate:intake", checker: "role:attorney", output: { kind: "sent", target: "email" }, how: "tailor", template: "welcome", depends_on: ["Research the client"] },
      ] },
      { name: "Engagement", tasks: [{ title: "Engagement letter signed", doer: "role:attorney", output: { kind: "decision" } }] },
      { name: "Drafting" },
      { name: "Review", tasks: [{ title: "Optional polish", doer: "role:manager", output: { kind: "note" }, required: false }] },
      { name: "Closed" },
    ] };
  return c;
};
