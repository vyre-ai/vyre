// @ts-check
// The diff card an admin approves (contract 9.2, R6-15, R6-16). It is built from the STORED canonical form (the compiled diff, roles and Flows)
// and the simulation, never from the model's words; whatever the model said is one separate quoted block with no links or buttons. The hash on
// the card is the hash of the canonical form, and it is what the admin's approval binds.

const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;
const INVISIBLE = /[​-‍⁠﻿­]/g;
/** A small table of letters that read as Latin ones, enough to flag the common look-alikes. */
const LOOKALIKE = /[аеорсхуіјѕһԁΑΒΕΖΗΙΚΜΝΟΡΤΥΧονı]/;
const OUTWARD_ACTION = /(^|\.)(send|pay|publish|delete|share)$/;

/**
 * A name as the card shows it: normalised, with what was wrong with it said. A definition cannot display one name and run another.
 * @param {string} name @returns {{ name: string, shown: string, flags: string[] }}
 */
export function nameFlags(name) {
  const raw = String(name);
  const flags = [];
  if (BIDI.test(raw)) flags.push("bidi");
  BIDI.lastIndex = 0;
  if (INVISIBLE.test(raw)) flags.push("invisible");
  INVISIBLE.lastIndex = 0;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(raw)) flags.push("non_ascii");
  if (LOOKALIKE.test(raw)) flags.push("lookalike");
  const shown = raw.normalize("NFKC").replace(BIDI, "").replace(INVISIBLE, "");
  return { name: raw, shown, flags };
}

/** Free text from a model as a quote: capped, control characters out, no markdown links, no URLs. @param {unknown} text */
export function quoteModelText(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(BIDI, "").replace(INVISIBLE, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/\b(?:https?|ftp|javascript|data):[^\s)]*/gi, "[link removed]")
    .slice(0, 600);
}

/** The outward steps of the Flows a proposal defines: a Flow that sends, pays, publishes, deletes or shares is flagged on the card. @param {any[]} flows */
export function outwardSteps(flows) {
  const out = [];
  for (const f of flows || []) for (const [i, s] of (f.steps || []).entries()) {
    const action = String(s.call ?? s.action ?? "");
    if (s.kind === "call" && OUTWARD_ACTION.test(action)) out.push({ flow: String(f.name), step: i + 1, action });
  }
  return out;
}

/**
 * @param {{ diff: any, hash: string, roles?: any[], flows?: any[], simulation: import("./simulate.js").Simulation, authorship?: string, outward?: any[], note?: string, summary?: string }} p
 */
export function diffCard(p) {
  const changes = [];
  /** @type {string[]} */ const names = [];
  const seen = (/** @type {string} */ n) => { names.push(n); return nameFlags(n).shown; };
  for (const t of p.diff?.add_types || []) changes.push(`Adds the type ${seen(t.name)} with ${(t.fields || []).length} fields${(t.stages || []).length ? ` and the stages ${t.stages.map((/** @type {any} */ s) => seen(s.name)).join(", ")}` : ""}.`);
  for (const t of p.diff?.change_types || []) changes.push(`Changes the type ${seen(t.name)}: ${(t.fields || []).length} fields${(t.stages || []).length ? `, stages ${t.stages.map((/** @type {any} */ s) => seen(s.name)).join(", ")}` : ""}.`);
  for (const n of p.diff?.remove_types || []) changes.push(`Removes the type ${seen(n)}.`);
  for (const f of p.flows || []) changes.push(`Adds the Flow ${seen(f.name)}${f.trigger ? `, which starts when ${String(f.trigger).slice(0, 80)}` : ""}.`);
  for (const r of p.roles || []) changes.push(`Adds the role ${seen(r.name)}, which may ${[...new Set((r.grants || []).flatMap((/** @type {any} */ g) => g.actions || []))].join(", ") || "do nothing"}.`);
  if (!changes.length) changes.push("Changes nothing.");
  const outward = p.outward || outwardSteps(p.flows || []);
  const sim = p.simulation;
  return {
    title: "A change to your definitions",
    hash: p.hash,
    authorship: p.authorship || "model-drafted",
    changes,
    simulation: sim.available
      ? { ok: sim.ok, text: sim.ok ? `Simulated ${sim.ran} scenarios in ${sim.steps} steps with no failure.` : `The simulation failed: ${sim.failures.map(f => f.msg).join("; ")}` }
      : { ok: false, text: "Not simulated: no simulator is available." },
    outward: outward.map(o => ({ ...o, text: `The Flow ${nameFlags(o.flow).shown} step ${o.step} would ${o.action}. Each use still waits for a person's approval.` })),
    names: names.map(nameFlags).filter(n => n.flags.length),
    fromEngineer: { label: "from the Engineer", quoted: true, interactive: false, text: quoteModelText(p.note ?? p.summary ?? "") },
  };
}
