// @ts-check
// The sample space's options for the Flow builder, and the two starter Flows the owner described: a refund request handed to the Refunds agent, and a new client who gets an ATP project.
// A real source answers the same Options from records.types, agents.list, work.template.list and roles.list.

/** @type {import("../../ui/flows/logic.js").Options} */
export const SAMPLE_OPTIONS = {
  types: [
    { name: "refund_requests", label: "RefundRequests", fields: [{ name: "client", label: "Client" }, { name: "email", label: "Email" }, { name: "amount", label: "Amount" }, { name: "reason", label: "Reason" }] },
    { name: "client", label: "Client", fields: [{ name: "name", label: "Name" }, { name: "email", label: "Email" }, { name: "plan", label: "Plan" }] },
    { name: "matter", label: "Matter", fields: [{ name: "client", label: "Client" }, { name: "stage", label: "Stage" }] },
  ],
  recordsOf: async (type) => [{ urn: `vyre://sample/${type}/r1`, label: "Pat Lopez" }, { urn: `vyre://sample/${type}/r2`, label: "Sam Ortiz" }],
  agents: [{ name: "refunds", label: "Refunds", staff: true }, { name: "intake", label: "Intake", staff: true }, { name: "research", label: "Research", staff: true }],
  templates: [
    { id: "tpl_atp", name: "ATP", stages: [
      { name: "Kickoff", tasks: [
        { title: "Book the kickoff call", doer: "lead" },
        { title: "Collect the client's accounts and access", doer: "role:paralegal" },
        { title: "Research the client's market", doer: "teammate:research" },
      ] },
      { name: "Audit", tasks: [{ title: "Run the AI visibility audit", doer: "teammate:research" }, { title: "Review the audit", doer: "role:attorney" }] },
      { name: "Roadmap", tasks: [{ title: "Present the roadmap", doer: "lead" }] },
      { name: "Handover", tasks: [] },
    ] },
    { id: "tpl_estate", name: "Estate plan", stages: [{ name: "Opening", tasks: [{ title: "Run the conflict check", doer: "role:paralegal" }] }, { name: "Closing", tasks: [] }] },
  ],
  roles: [{ name: "attorney", label: "Attorney" }, { name: "paralegal", label: "Paralegal" }, { name: "manager", label: "Manager" }],
  people: [{ name: "ana", label: "Ana Ruiz" }, { name: "chris", label: "Chris Park" }],
};

/** @type {import("../../ui/flows/logic.js").Draft} */
export const REFUND_DRAFT = {
  name: "Refund request", group: "Money",
  trigger: { kind: "form", path: "refund-request" },
  steps: [
    { id: "create1", kind: "create", type: "refund_requests", fields: [{ field: "Client", value: "{name}" }, { field: "Email", value: "{email}" }, { field: "Amount", value: "{amount}" }, { field: "Reason", value: "{reason}" }] },
    { id: "agent2", kind: "agent", agent: "refunds", title: "Handle this refund request", record: "create1",
      instructions: "Check the request against our refund policy. Refund up to $500 yourself and email the client from the support alias. Anything larger goes to the manager for a yes first. Close the record when it is paid." },
  ],
};

/** @type {import("../../ui/flows/logic.js").Draft} */
export const ATP_DRAFT = {
  name: "New ATP client", group: "Clients",
  trigger: { kind: "signup" },
  steps: [
    { id: "create1", kind: "create", type: "client", fields: [{ field: "Name", value: "{name}" }, { field: "Email", value: "{email}" }] },
    { id: "project2", kind: "project", template: "tpl_atp", name: "", link: "create1" },
    { id: "email3", kind: "email", to: "{email}", subject: "Welcome to your AI Transformation Partnership", body: "Hello, your ATP project is open and your first call is being booked." },
  ],
};
