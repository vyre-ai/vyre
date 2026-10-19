// @ts-check
// The sample world's roles, for the screenshots and the demo only (a box that is not the sample answers records.roles.summary itself; useRoleChips and Roles reach this only when allowsMock() says the world is the made-up one).
// Same shape as records.roles.summary, so the screens draw it exactly as they draw a real answer.

export const SAMPLE_KINDS = [
  { role: "role-lead", label: "Lead", color: "orange", stages: ["New", "Talking", "Won", "Lost"] },
  { role: "role-client", label: "Client", color: "green", stages: ["Active", "Past"] },
  { role: "role-partner", label: "Partner", color: "purple", stages: [] },
  { role: "role-vendor", label: "Vendor", color: "red", stages: [] },
];

/** @type {Record<string, [string, string?, boolean?][]>} what each sample person is: [role, stage, ended] */
const BY_NAME = {
  "Dana Reyes": [["role-client", "Active"], ["role-partner"]],
  "Jane Doe": [["role-client", "Active"]],
  "John Roe": [["role-lead", "Talking"]],
  "Lena Ortiz": [["role-vendor"]],
  "Marcus Doe": [["role-lead", "New"]],
  "Priya Shah": [["role-client", "Past", true], ["role-lead", "Won", true]],
};

/** The held roles of a sample person by name, shaped as records.roles.summary answers them; empty for anyone else. @param {string} name @param {string} urn */
export function sampleHeld(name, urn) {
  return (BY_NAME[name] || []).map(([role, stage, ended]) => {
    const k = SAMPLE_KINDS.find((x) => x.role === role);
    return { role, label: k ? k.label : role, stage, current: !ended, color: k ? k.color : "gray", urn: `${urn}#${role}` };
  });
}
