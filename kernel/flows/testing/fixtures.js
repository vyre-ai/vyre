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
    "records.read": { risk: "read" }, "records.create": { risk: "write" }, "records.update": { risk: "write" }, "records.remove": { risk: "outward.delete" },
  },
  roles: ["owner", "admin", "manager", "member", "attorney"],
  teammates: ["research", "intake"],
  templates: ["welcome"],
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
