// @ts-check
// Labels of derived content (contract 7.6): the weakest trust of the inputs, the strongest redaction class, and every Space the content
// came from. Pure, so teammates, memory and @Engineer all join labels one way.

import { TRUST_ORDER, REDACTION_ORDER } from "../kernel/contracts/index.js";

/** @typedef {{ trust: "system"|"member"|"external"|"untrusted", red: "public"|"internal"|"pii"|"privileged"|"secret", source_spaces: readonly string[] }} Labels */

/** What a person or member writes inside their own Space. @param {string} space @returns {Labels} */
export const memberLabels = space => ({ trust: "member", red: "internal", source_spaces: [space] });

/** Content from outside the Space (mail, web, Kit text until reviewed). @param {string} space @returns {Labels} */
export const externalLabels = space => ({ trust: "external", red: "internal", source_spaces: [space] });

/**
 * The labels of something derived from all of `inputs`: lowest trust, highest class, union of Spaces. No inputs read as system and public
 * (nothing was consumed), which a caller never relies on for a model's words: those carry the labels of what the model read.
 * @param {readonly (Labels|null|undefined)[]} inputs @returns {Labels}
 */
export function joinLabels(inputs) {
  let trust = TRUST_ORDER.length - 1, red = 0;
  const spaces = new Set();
  for (const l of inputs) {
    if (!l) continue;
    trust = Math.min(trust, Math.max(0, TRUST_ORDER.indexOf(l.trust)));
    red = Math.max(red, Math.max(0, REDACTION_ORDER.indexOf(l.red)));
    for (const s of l.source_spaces || []) spaces.add(s);
  }
  return { trust: /** @type {any} */ (TRUST_ORDER[trust]), red: /** @type {any} */ (REDACTION_ORDER[red]), source_spaces: [...spaces].sort() };
}

/** True when `a` is at most as trusted as `b`. @param {Labels} a @param {Labels} b */
export const noMoreTrustedThan = (a, b) => TRUST_ORDER.indexOf(a.trust) <= TRUST_ORDER.indexOf(b.trust);

/** An `external` or `untrusted` label: content a model must treat as data, and an outward act from it needs an approval naming the source. @param {Labels} l */
export const isTainted = l => l.trust === "external" || l.trust === "untrusted";
