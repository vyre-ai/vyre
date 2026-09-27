// @ts-check
// personal/model: the vocabulary the fast model may use for personal facts, shared by the reader
// (./reader.js) that sends user turns to it and checks what comes back. The relations and
// reference kinds match extract.js, so a model claim and a rule claim about the same thing are
// one fact in the store.

export const ROLE_WORDS = /** @type {Record<string, RegExp>} */ ({
  spouse: /\b(?:wife|husband|spouse)\b/i, partner: /\b(?:partner|girlfriend|boyfriend|fianc\w*)\b/i,
  mother: /\b(?:mother|mom|mum|mama|ma)\b/i, father: /\b(?:father|dad)\b/i, sister: /\bsisters?\b/i, brother: /\bbrothers?\b/i,
  son: /\bsons?\b/i, daughter: /\bdaughters?\b/i, child: /\b(?:kids?|child|children)\b/i,
  dog: /\b(?:dogs?|pupp(?:y|ies))\b/i, cat: /\b(?:cats?|kittens?)\b/i,
  friend: /\b(?:friends?|buddy|buddies|pals?|bestie|mate)\b/i,
});
export const KIN_RELS = new Set(["spouse", "partner", "mother", "father", "sister", "brother", "son", "daughter", "child", "pet", "friend"]);
/** Diets the model may name: the same values the rules keep. */
export const DIETS = new Set(["vegetarian", "vegan", "pescatarian", "plant-based", "keto", "paleo", "gluten-free", "halal", "kosher"]);
/** Relations whose subject may be anyone the user talks about; the rest are the user's own. */
export const ANYONE = new Set(["name", "lives_in", "from", "works_at", "role", "birthday", "diet", "breed", "owns", "drives", "age", "hobby"]);
/** Relation -> the reference kinds its object may be. */
export const OBJ = /** @type {Record<string, string[]>} */ ({
  name: ["lit"], lives_in: ["place"], from: ["place"], works_at: ["org"], client: ["org"], role: ["lit"],
  drives: ["vehicle"], owns: ["vehicle", "lit"], uses: ["tool"], prefers: ["lit"], birthday: ["lit"], diet: ["lit"], breed: ["lit"], age: ["lit"], hobby: ["lit"],
  ...Object.fromEntries([...KIN_RELS].map(r => [r, ["kin", "name"]])),
});
export const RELS = Object.keys(OBJ);
export const NAME = /^[A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?$/;
