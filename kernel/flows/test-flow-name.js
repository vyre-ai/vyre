// @ts-check
// Flow definitions in tests must satisfy checkFlow's NAME_RE. This slug is the one place tests turn a readable label into that name.

/** @param {string} label */
export function testFlowName(label) {
  const slug = String(label).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return slug || "f";
}

/** @param {string} label @param {any} trigger @param {any[]} steps */
export function testFlowDef(label, trigger, steps) {
  return { name: testFlowName(label), trigger, steps };
}
