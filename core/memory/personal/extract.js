// @ts-check
// personal/extract: what one turn says about the user and the people and things in their life
// (docs/work/memory-iq.md). "my wife Jordan", "her birthday is 14 March", "we moved to Seattle",
// "the Volvo needs a service".
//
// Pure, like ../extract.js: text in, claims out. No database, no clock, no model. The user's own
// turns are the source. Claude's turns can only echo what the user said ("your wife Jordan"), so
// they give weak claims and never the user's name. Rules stay precise and leave the rest to a
// later model pass: a sentence with a personal cue word that no rule understood comes back as a
// cue, not as a guess.
//
// References (subjects and objects): me, kin:<role>, name:<Name>, lit:<text>, vehicle:<Make Model>,
// place:<Name>, org:<Name>, tool:<name>. Two relations are bookkeeping for the store rather than
// facts: `called` (the word the user used for a relative: wife, mum) and `ended:owns` (a thing
// sold or given up).

import { OPENERS } from "../lexicon.js";

/** Confidence per claim by how it was said (docs/work/memory-iq.md, Confidence). */
export const CONF = { explicit: 0.9, indirect: 0.7, model: 0.75, assistant: 0.35 };

/** Roles that name one person: "my wife" is always the same one. */
export const SINGULAR = new Set(["spouse", "partner", "mother", "father"]);

/** Relations where one value holds at a time: a new value competes with the old one. */
export const SINGLE_VALUED = new Set(["name", "birthday", "lives_in", "from", "works_at", "role", "drives", "spouse", "partner", "mother", "father"]);
/** Of those, the ones that change over a life: the newest value is favoured, not just tie-broken. */
export const TIME_VARYING = new Set(["lives_in", "works_at", "role", "drives"]);

/** word -> [role, gender]. Gender only steers she/he; null matches either. */
const KIN = /** @type {Record<string, [string, "f"|"m"|null]>} */ ({
  wife: ["spouse", "f"], husband: ["spouse", "m"], spouse: ["spouse", null],
  partner: ["partner", null], girlfriend: ["partner", "f"], boyfriend: ["partner", "m"], fiancee: ["partner", "f"], fiance: ["partner", "m"],
  mother: ["mother", "f"], mom: ["mother", "f"], mum: ["mother", "f"], father: ["father", "m"], dad: ["father", "m"],
  sister: ["sister", "f"], brother: ["brother", "m"], son: ["son", "m"], daughter: ["daughter", "f"],
  kid: ["child", null], kids: ["child", null], child: ["child", null], children: ["child", null],
  dog: ["dog", null], puppy: ["dog", null], cat: ["cat", null], kitten: ["cat", null],
});
const PLURAL = new Set(["kids", "children"]);
/** The relation from me to a relative in that role. */
export const relOfRole = role => (role === "dog" || role === "cat" ? "pet" : role);
const KINW = "wife|husband|spouse|partner|girlfriend|boyfriend|fianc[eé]e?|mother|mom|mum|father|dad|sister|brother|son|daughter|kids|kid|children|child|dog|puppy|cat|kitten";
const KINMOD = "lovely|dear|beautiful|amazing|wonderful|older|younger|little|big|baby|eldest|oldest|youngest|middle|two|three|twin|new";
const kinKey = w => w.toLowerCase().replace(/é/g, "e");

// Car makes: generic brands, the same for everyone, so they may live in code.
const MAKES = ["Alfa Romeo", "Aston Martin", "Land Rover", "Range Rover", "Mercedes-Benz", "Mercedes", "Toyota", "Honda", "Ford",
  "Chevrolet", "Chevy", "Tesla", "Volvo", "BMW", "Audi", "Subaru", "Mazda", "Nissan", "Hyundai", "Kia", "Volkswagen", "VW", "Jeep",
  "Lexus", "Porsche", "Rivian", "Polestar", "Jaguar", "Mini", "Fiat", "Dodge", "GMC", "Cadillac", "Buick", "Acura", "Infiniti",
  "Lincoln", "Mitsubishi", "Skoda", "Peugeot", "Renault", "Citroen", "Genesis", "Lucid", "Prius"];
const MAKE_SET = new Set(MAKES.map(m => m.toLowerCase()));
// A capitalised word after a make that says it is a company, not a car ("the Ford Foundation").
const NOT_MODEL = new Set("foundation motor motors company group credit financial finance dealership dealer center centre store stadium arena park inc corp corporation stock shares earnings".split(" "));
const VEHICLE = `(?<make>${MAKES.map(m => m.replace(/-/g, "\\-")).join("|")})(?:\\s+(?<model>Model\\s+[A-Z0-9]\\b|[A-Z0-9][A-Za-z0-9-]*))?`;
// Words after "the Volvo" that say it is a car the user has, not a brand in the news.
const CARISH = /^\s+(?:needs|need|broke|won't|wont|keeps|got|is\s+in\s+the\s+shop|is\s+due|service|tires|tyres|battery|brakes|oil|keys|lease|insurance|registration|inspection|repair|parked|still|started|starts|makes|made|has\s+a\s+flat)\b/;

// Demonyms and other capitalised adjectives that follow "I'm" or "my wife is" without being names.
const NOT_NAME = new Set(`american british canadian english irish scottish welsh french german italian spanish mexican indian
  pakistani chinese japanese korean australian dutch swedish norwegian danish finnish polish russian brazilian portuguese greek
  turkish african european asian muslim christian jewish catholic hindu buddhist vegan vegetarian ok okay fine back done here
  ready sure happy glad sorry afraid curious`.split(/\s+/));

const NAME = "[A-Z][a-z]*(?:'[A-Z])?[a-z]+(?:-[A-Z][a-z]+)?(?:\\s+[A-Z][a-z]*(?:'[A-Z])?[a-z]+(?:-[A-Z][a-z]+)?)?";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(?:[Jj]an(?:uary)?|[Ff]eb(?:ruary)?|[Mm]ar(?:ch)?|[Aa]pr(?:il)?|[Mm]ay|[Jj]une?|[Jj]uly?|[Aa]ug(?:ust)?|[Ss]ep(?:t(?:ember)?)?|[Oo]ct(?:ober)?|[Nn]ov(?:ember)?|[Dd]ec(?:ember)?)\\b\\.?";
const DATE = `(?:(?<d1>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<m1>${MONTH})|(?<m2>${MONTH})\\s+(?<d2>\\d{1,2})(?:st|nd|rd|th)?\\b)(?:,?\\s+(?<y>(?:19|20)\\d\\d))?`;
const ORG = "[A-Z][\\w'&.-]*(?:\\s+(?:&\\s+)?[A-Z][\\w'&.-]*){0,4}";
const PLACE = "[A-Z][a-z]+(?:[\\s-][A-Z][a-z]+){0,2}";
const TOOL = "[A-Z][\\w.+#-]*(?:\\s+[A-Z][\\w.+#-]*){0,2}|[a-z][\\w.+#-]{1,30}";
const TOOL_STOP = new Set(`it this that the a an them these those both my your our his her their some any all to for and or in on with of one
  each either neither only just what which mostly mainly also as when if more less same different another other such much many
  lots less very really`.split(/\s+/));
const OWN_STOP = new Set("lot few couple bit piece share copy license licence little number pair".split(" "));

/** Words that make a clause hypothetical. Checked between the clause's start and the match. */
const HYPO = /\b(?:if|suppose|supposing|imagine|imagined|pretend|hypothetically|assume|assuming|wish|unless|whether|e\.g\.|for example|for instance|let's say|say that|what if)\b/i;
const NEG_BEFORE = /(?:\bnot|\bnever|\bno|n't|\bnor|\bwithout)\s+(?:\w+\s+){0,1}$/i;
const QUESTION_START = /^(?:what|who|whose|which|where|how)\b|^(?:do|does|did|can|could|would|will|is|are|am)\s+(?:you|i|my|we|it|there|your)\b/i;
const CUE = /\b(?:wife|husband|spouse|partner|girlfriend|boyfriend|fianc\w*|mom|mum|mother|dad|father|sister|brother|son|daughter|kids?|children|dog|cat|car|live|lives|lived|moved|birthday|born|anniversary|drive|drives|married|home|house|apartment|pet)\b/i;
const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|my|we|our|me|us)\b/;
const SECOND_PERSON = /\b(?:you|your|you're|you've)\b/i;

/** Longest turn read in full. A longer one is mostly pasted material: only its first-person sentences are read. */
export const LONG_TURN = 4000;

/**
 * The regexes for one point of view: the user says "my wife", Claude says "your wife".
 * @param {"user"|"assistant"} who
 */
function build(who) {
  const u = who === "user";
  const MY = u ? "[Mm]y" : "[Yy]our";
  const MYOUR = u ? "[Mm]y|[Oo]ur" : "[Yy]our";
  const I = u ? "I|[Ww]e" : "[Yy]ou";
  const kinP = `${MY}\\s+(?:(?:${KINMOD})\\s+)?(?<kw>${KINW})`;
  const g = s => new RegExp(s, "g");
  return {
    // Subject right before a predicate: "I", "we", "she", "my wife", "my wife Jordan", "Jordan".
    subj: new RegExp(`(?:^|[\\s,;:(])(?:(?<i>${I})|(?<p>[Ss]he|[Hh]e)|${MY}\\s+(?:(?:${KINMOD})\\s+)?(?<k>${KINW})(?:,?\\s+(?<kn>${NAME}),?)?|(?<n>${NAME}))(?<aux>(?:'m|'re|'s|'ve|\\s+(?:am|are|is|was|were|have|has|had|also|still|now|currently|actually|originally|both|all|just|finally|recently|already))*)\\s+$`),
    // Possessor right before a noun: "my", "our", "her", "my wife's", "Jordan's".
    poss: new RegExp(`(?:^|[\\s,;:(])(?:(?<i>${MYOUR})|(?<p>[Hh]er|[Hh]is)|${MY}\\s+(?:(?:${KINMOD})\\s+)?(?<k>${KINW})(?:\\s+(?<kn>${NAME}))?'s|(?<n>${NAME})'s)\\s+$`),
    kin: g(`(?<![A-Za-z'])${kinP}\\b(?!'s|-)`),
    kinName: g(`(?<![A-Za-z'])${kinP}'s\\s+name\\s+is\\s+(?<n>${NAME})`),
    nameParen: g(`(?<n>${NAME})\\s*\\(\\s*${kinP}\\s*\\)`),
    nameComma: g(`(?<n>${NAME}),\\s+${kinP}\\b(?!'s)(?=\\s*(?:[,.;:!)]|$))`),
    myName: g(`\\b${MY}\\s+name(?:'s|\\s+is)\\s+(?<n>${NAME})`),
    imName: new RegExp(`^(?:(?:[Hh]i|[Hh]ello|[Hh]ey)[,!]?\\s+)?(?:I'm|I\\s+am|[Cc]all\\s+me)\\s+(?<n>${NAME})(?=\\s*(?:[,.!;:]|and\\b|$))`),
    myCar: g(`\\b${MY}\\s+(?:car|ride)\\s+is\\s+(?:a|an)\\s+(?:(?:new|used|old)\\s+)?(?:(?:19|20)\\d\\d\\s+)?${VEHICLE}`),
    myEditor: g(`\\b${MY}\\s+(?:code\\s+|text\\s+)?editor(?:\\s+of\\s+choice)?\\s+is\\s+(?<t>${TOOL})`),
    clientIs: g(`(?<o>${ORG})\\s+(?:is|are)\\s+(?:a|an|our|my|${MY})\\s+(?:(?:new|big|biggest|long-?time|key|good|great)\\s+)?client\\b`),
    ourClient: g(`\\b(?:${MYOUR})\\s+(?:(?:new|big|biggest|key)\\s+)?client,?\\s+(?<o>${ORG})`),
    mention: g(`(?<![A-Za-z])(?<det>${MYOUR}|[Tt]he)\\s+${VEHICLE}\\b`),
    // Predicates. subj: which tail must precede; aux: the tail must carry a be-verb ("I'm from").
    preds: [
      { hint: /\b(?:live|lives|living|reside|resides|based|settled)\b/, re: g(`\\b(?:live|lives|living|reside|resides|based|settled)\\s+in\\s+(?:the\\s+)?(?<pl>${PLACE})`), rel: "lives_in", ob: "place", tail: "subj" },
      { hint: /\b(?:moved|relocated)\b/, re: g(`\\b(?:moved|relocated)\\s+(?:back\\s+|over\\s+|out\\s+)?(?:from\\s+${PLACE}\\s+)?to\\s+(?<pl>${PLACE})`), rel: "lives_in", ob: "place", tail: "subj" },
      { hint: /\bfrom\s+[A-Z]/, re: g(`\\bfrom\\s+(?<pl>${PLACE})`), rel: "from", ob: "place", tail: "subj", aux: true },
      { hint: /\b(?:come|comes|came)\s+from\b/, re: g(`\\b(?:come|comes|came)\\s+from\\s+(?<pl>${PLACE})`), rel: "from", ob: "place", tail: "subj" },
      { hint: /\b(?:grew|born)\b/, re: g(`\\b(?:grew\\s+up|was\\s+born|born\\s+and\\s+raised)\\s+in\\s+(?<pl>${PLACE})`), rel: "from", ob: "place", tail: "subj", conf: CONF.indirect },
      { hint: /\bwork(?:s|ing)?\s+(?:at|for)\s+[A-Z]/, re: g(`\\b(?:work|works|working)\\s+(?:at|for)\\s+(?<o>${ORG})`), rel: "works_at", ob: "org", tail: "subj" },
      { hint: /\b(?:run|runs|founded|co-?founded)\s+[A-Z]/, re: g(`\\b(?:run|runs|founded|co-?founded)\\s+(?<o>${ORG})`), rel: "works_at", ob: "org", tail: "subj", conf: CONF.indirect, role: "owner" },
      { hint: /(?:'m|\b(?:am|is|was))\s+(?:the|a|an)\b[^.]*\s(?:at|for)\s+[A-Z]/, re: g(`\\b(?:the|a|an)\\s+(?<r>[A-Za-z][A-Za-z-]+(?:\\s+(?:of\\s+)?[a-z][a-z-]+){0,3})\\s+(?:at|for)\\s+(?<o>${ORG})`), rel: "works_at", ob: "org", tail: "subj", aux: true },
      { hint: /\bwork(?:s|ing)?\s+as\b/, re: g(`\\bwork(?:s|ing)?\\s+as\\s+(?:a|an|the)\\s+(?<r>[A-Za-z][A-Za-z-]+(?:\\s+[a-z][a-z-]+){0,3})\\s+(?:at|for)\\s+(?<o>${ORG})`), rel: "works_at", ob: "org", tail: "subj" },
      { car: true, re: g(`\\b(?:drive|drives|driving)\\s+(?:a|an|the|my|our|${MY})\\s+(?:(?:new|used|old)\\s+)?(?:(?:19|20)\\d\\d\\s+)?${VEHICLE}`), rel: "drives", ob: "vehicle", tail: "subj" },
      { car: true, re: g(`\\b(?:own|owns|bought|have|has|got|leased|lease)\\s+(?:a|an|the)\\s+(?:(?:new|used|old)\\s+)?(?:(?:19|20)\\d\\d\\s+)?${VEHICLE}`), rel: "owns", ob: "vehicle", tail: "subj" },
      { hint: /\bowns?\s+an?\s/, re: g(`\\b(?:own|owns)\\s+(?:a|an)\\s+(?<th>[a-z][a-z-]+(?:\\s+[a-z][a-z-]+)?)`), rel: "owns", ob: "thing", tail: "subj" },
      { car: true, re: g(`\\b(?:sold|got\\s+rid\\s+of|traded\\s+in|scrapped)\\s+(?:the|our|my|${MY})\\s+(?:old\\s+)?${VEHICLE}`), rel: "ended:owns", ob: "vehicle", tail: "subj" },
      { hint: /\buses?\s/, re: g(`\\b(?:use|uses)\\s+(?<t>${TOOL})`), rel: "uses", ob: "tool", tail: "subj" },
      { hint: /\bprefers?\s/, re: g(`\\bprefers?\\s+(?<ph>[^.,;!?\\n]{2,80})`), rel: "prefers", ob: "phrase", tail: "subj" },
      { hint: /\bborn\s+on\b/, re: g(`\\bborn\\s+on\\s+(?:the\\s+)?${DATE}`), rel: "birthday", ob: "date", tail: "subj", aux: true, names: true },
      { hint: /\bbirthday\b/, re: g(`\\bbirthday(?:'s|\\s+is|\\s+falls)?\\s+(?:is\\s+)?(?:on\\s+)?(?:the\\s+)?${DATE}`), rel: "birthday", ob: "date", tail: "poss", names: true },
    ],
  };
}
const RX = { user: build("user"), assistant: build("assistant") };
/** What may follow "my wife" to name her: "Jordan", ", Jordan,", "is Jordan", "called Jordan"; "my kids Sam and Juno". */
const AFTER = {
  list: new RegExp(`^,?\\s+(${NAME}(?:,\\s*${NAME})*(?:,?\\s+and\\s+${NAME})?)`),
  one: new RegExp(`^,?\\s+(${NAME})(?=[\\s,.!?;:)]|'s|$)`),
  is: new RegExp(`^\\s+(?:is|'s)\\s+(?:called\\s+|named\\s+)?(${NAME})(?=\\s*(?:[,.!;:]|and\\b|$))`),
  called: new RegExp(`^,?\\s+(?:called|named)\\s+(${NAME})`),
};
// Cheap tests that decide which rules a sentence can need at all. Most turns are about code and
// pass none of them, which is what keeps a first pass over a large history fast.
const HAS_KIN = new RegExp(`\\b(?:${KINW})\\b`, "i");
const HAS_CAR = new RegExp(`\\b(?:${MAKES.join("|")})\\b`);
const HAS_NAME = /\bname\b|\bI'm\s+[A-Z]|\bI\s+am\s+[A-Z]|\b[Cc]all\s+me\s/;

const lower = s => s.toLowerCase();
/** Drops leading words that open sentences ("Yesterday Jordan" is Jordan) and any trailing opener. */
function cleanName(n) {
  const w = String(n || "").split(/\s+/).filter(Boolean);
  while (w.length && OPENERS.has(lower(w[0]))) w.shift();
  while (w.length > 1 && OPENERS.has(lower(w[w.length - 1]))) w.pop();
  if (!w.length || NOT_NAME.has(lower(w[0])) || MAKE_SET.has(lower(w[0]))) return null;
  return w.join(" ");
}
const trimRun = s => String(s || "").replace(/[.,;:'&-]+$/, "").trim();
function cleanRun(s) {
  const w = trimRun(s).split(/\s+/).filter(Boolean);
  while (w.length && OPENERS.has(lower(w[0]))) w.shift();
  if (!w.length || OPENERS.has(lower(w[w.length - 1]))) return null;
  return trimRun(w.join(" ")) || null;
}
function dateOf(gr) {
  const d = Number(gr.d1 || gr.d2), m = String(gr.m1 || gr.m2 || "").toLowerCase().replace(/\.$/, "");
  const mi = MONTHS.findIndex(x => x.startsWith(m.slice(0, 3)));
  if (mi < 0 || !(d >= 1 && d <= 31)) return null;
  const name = MONTHS[mi][0].toUpperCase() + MONTHS[mi].slice(1);
  return `${d} ${name}${gr.y ? " " + gr.y : ""}`;
}
function vehicleOf(gr) {
  if (!gr.make) return null;
  let model = gr.model || "";
  if (model && NOT_MODEL.has(lower(model))) return null;
  if (model && (OPENERS.has(lower(model)) || MAKE_SET.has(lower(model)))) model = "";
  return `vehicle:${gr.make}${model ? " " + model : ""}`;
}

/**
 * The text worth reading: no code, no quoted or pasted material, no letter someone pasted in.
 * @param {string} text
 * @param {"user"|"assistant"} who
 */
function readable(text, who) {
  let t = String(text).replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/"""[\s\S]*?(?:"""|$)/g, "\n").replace(/`[^`\n]*`/g, " ");
  const out = [];
  let letter = false, sig = 0;
  for (const line of t.split("\n")) {
    if (sig > 0) { sig--; if (line.trim().length < 40) continue; }
    if (/^\s*>/.test(line) || /^\s*(?:From|To|Cc|Bcc|Subject|Date|Sent):\s/.test(line)) continue;
    if (!letter && /^\s*(?:Dear\s+[^\n]{1,60}|To whom it may concern)[,:]?\s*$/i.test(line)) { letter = true; continue; }
    if (letter) {
      if (/^\s*(?:Sincerely|Best regards|Kind regards|Warm regards|Regards|Yours sincerely|Yours truly|Yours faithfully|Respectfully|Best|Cheers|Thank you|Thanks)[,.!]?\s*$/i.test(line)) { letter = false; sig = 2; }
      continue;
    }
    out.push(line);
  }
  let s = out.join("\n").split(/(?<=[.!?])\s+(?=[A-Z"'(])|\n+/).map(x => x.trim()).filter(Boolean);
  if (t.length > LONG_TURN) s = s.filter(x => (who === "user" ? FIRST_PERSON : SECOND_PERSON).test(x));
  return s;
}

/**
 * @typedef {{ subj: string, rel: string, obj: string, conf: number, method: string }} Claim
 * @typedef {{ ref: string, g: "f"|"m"|null, name?: string|null, age?: number }} Focus
 */

/**
 * What one turn says about the user.
 * @param {unknown} text
 * @param {{ role?: string, prev?: Focus|string|null }} [opts]  role: "user" or "assistant";
 *   prev: the focus the previous turn returned, so "her" can mean the wife named a turn ago.
 * @returns {{ claims: Claim[], focus: Focus|null, cues: string[] }}
 */
export function extractPersonal(text, { role = "user", prev = null } = {}) {
  const who = role === "assistant" ? "assistant" : "user";
  const prevF = typeof prev === "string" ? { ref: prev, g: null, name: null, age: 0 } : prev && prev.ref ? prev : null;
  const carried = prevF && (prevF.age || 0) < 2 ? { ...prevF, age: (prevF.age || 0) + 1 } : null;
  if (typeof text !== "string" || !text.trim()) return { claims: [], focus: carried, cues: [] };
  const R = RX[who];
  const assistant = who === "assistant";
  const explicit = assistant ? CONF.assistant : CONF.explicit;
  const indirect = assistant ? CONF.assistant : CONF.indirect;
  const method = assistant ? "assistant" : "rule";

  /** @type {Map<string, Claim>} */
  const claims = new Map();
  const add = (subj, rel, obj, conf) => {
    const k = `${subj}|${rel}|${obj}`;
    const c = claims.get(k);
    if (!c || c.conf < conf) claims.set(k, { subj, rel, obj, conf, method: conf === CONF.indirect && !assistant ? "indirect" : method });
  };
  /** Names said this turn: name (and first name) -> the reference it stands for. */
  const names = new Map();
  /** People mentioned this turn, in order: who "she" and "he" can mean. */
  /** @type {Focus[]} */
  const cands = [];
  const cues = [];

  /** Link a relative: "my wife" (no names), "my wife Jordan", "my kids Sam and Juno". Returns the reference. */
  const kin = (word, list, conf) => {
    const key = kinKey(word);
    const k = KIN[key];
    if (!k) return null;
    const [roleName, g] = k;
    const kref = `kin:${roleName}`;
    const named = list.map(cleanName).filter(Boolean);
    add("me", relOfRole(roleName), kref, named.length ? conf : Math.min(conf, indirect));
    add(kref, "called", `lit:${lower(word)}`, named.length ? conf : Math.min(conf, indirect));
    let ref = kref;
    for (const n of /** @type {string[]} */ (named)) {
      add(kref, "name", `lit:${n}`, conf);
      const r = SINGULAR.has(roleName) ? kref : `name:${n}`;
      names.set(n, { ref: r, g }); names.set(n.split(" ")[0], { ref: r, g });
      if (!SINGULAR.has(roleName)) ref = r;
    }
    if (PLURAL.has(key) || named.length > 1 && !SINGULAR.has(roleName)) return null;
    cands.push({ ref, g, name: named[0] || null });
    return ref;
  };

  /** she/he/her/his: the one person of that gender this turn (or the last) could mean, else null. */
  const pronoun = (word, sentence, idx) => {
    const g = /^(?:she|her)$/i.test(word) ? "f" : "m";
    // Someone else named earlier in the sentence ("Dana said her ...") makes it ambiguous.
    for (const m of sentence.slice(0, idx).matchAll(/\b[A-Z][a-z]+\b/g)) {
      const t = m[0];
      if (t === "I" || OPENERS.has(lower(t)) || names.has(t) || MAKE_SET.has(lower(t)) || KIN[lower(t)]) continue;
      return null;
    }
    const fit = [...new Map(cands.filter(c => !c.g || c.g === g).map(c => [c.ref, c])).values()];
    if (fit.length === 1) return fit[0].ref;
    if (fit.length > 1) return null;
    if (prevF && (!prevF.g || prevF.g === g) && (prevF.age || 0) < 2) return prevF.ref;
    return null;
  };

  /**
   * The reference a subject tail names, or null.
   * @param {Record<string, string|undefined>} gr
   */
  const subjectOf = (gr, sentence, idx, allowName) => {
    if (gr.i) return { ref: "me", conf: explicit };
    if (gr.p) { const r = pronoun(gr.p, sentence, idx); return r ? { ref: r, conf: indirect } : null; }
    if (gr.k) {
      const r = kin(gr.k, gr.kn ? [gr.kn] : [], explicit);
      if (!r) return null;
      return { ref: r, conf: explicit };
    }
    if (gr.n) {
      const n = cleanName(gr.n);
      if (!n) return null;
      const known = names.get(n) || names.get(n.split(" ")[0]);
      if (known) return { ref: known.ref, conf: explicit };
      if (prevF?.name && (prevF.name === n || prevF.name.split(" ")[0] === n)) return { ref: prevF.ref, conf: explicit };
      return allowName ? { ref: `name:${n}`, conf: explicit } : null;
    }
    return null;
  };

  /** Is the match at idx negated, hypothetical, or inside a question's clause? */
  const unsure = (sentence, idx) => {
    const before = sentence.slice(0, idx);
    const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":")) + 1);
    return HYPO.test(clause) || NEG_BEFORE.test(before.slice(-24)) || /\b(?:would|could|might)\s+be\b/.test(sentence.slice(idx, idx + 60));
  };

  for (const sentence of readable(text, who)) {
    const before = claims.size;
    const question = /\?\s*["')]*$/.test(sentence) || QUESTION_START.test(sentence);
    if (question) continue;

    const hasKin = HAS_KIN.test(sentence), hasCar = HAS_CAR.test(sentence);
    // Names first, so a subject later in the sentence can use them.
    if (hasKin) {
    for (const m of sentence.matchAll(R.kinName)) if (!unsure(sentence, m.index)) kin(m.groups.kw, [m.groups.n], explicit);
    for (const m of sentence.matchAll(R.nameParen)) if (!unsure(sentence, m.index)) kin(m.groups.kw, [m.groups.n], explicit);
    for (const m of sentence.matchAll(R.nameComma)) if (!unsure(sentence, m.index)) kin(m.groups.kw, [lastName(m.groups.n)], explicit);
    for (const m of sentence.matchAll(R.kin)) {
      if (unsure(sentence, m.index)) continue;
      const word = m.groups.kw, rest = sentence.slice(m.index + m[0].length);
      const plural = PLURAL.has(kinKey(word));
      const list = [];
      let nm;
      if (plural && (nm = AFTER.list.exec(rest))) {
        list.push(...nm[1].split(/\s*,\s*|\s+and\s+/));
      } else if ((nm = AFTER.one.exec(rest))) {
        list.push(nm[1]);
      } else if ((nm = AFTER.is.exec(rest))) {
        list.push(nm[1]);
      } else if ((nm = AFTER.called.exec(rest))) {
        list.push(nm[1]);
      }
      // "my wife isn't Jordan", "my wife was never ...": said about her, but denied.
      if (/^\s+(?:isn't|is\s+not|wasn't|was\s+not|never)\b/.test(rest)) continue;
      kin(word, list.filter(n => cleanName(n)), explicit);
    }
    }
    if (!assistant && HAS_NAME.test(sentence)) {
      for (const m of sentence.matchAll(R.myName)) { const n = cleanName(m.groups.n); if (n && !unsure(sentence, m.index)) add("me", "name", `lit:${n}`, explicit); }
      const im = R.imName.exec(sentence);
      if (im) { const n = cleanName(im.groups.n); if (n) add("me", "name", `lit:${n}`, CONF.indirect); }
    }
    if (hasCar) for (const m of sentence.matchAll(R.myCar)) { const v = vehicleOf(m.groups); if (v && !unsure(sentence, m.index)) add("me", "owns", v, explicit); }
    if (sentence.includes("editor")) for (const m of sentence.matchAll(R.myEditor)) { const t = toolOf(m.groups.t); if (t && !unsure(sentence, m.index)) add("me", "uses", t, explicit); }
    if (sentence.includes("client")) for (const m of sentence.matchAll(R.clientIs)) {
      const o = cleanRun(m.groups.o);
      if (o && !unsure(sentence, m.index)) add("me", "client", `org:${o}`, explicit);
    }
    if (sentence.includes("client")) for (const m of sentence.matchAll(R.ourClient)) { const o = cleanRun(m.groups.o); if (o && !unsure(sentence, m.index)) add("me", "client", `org:${o}`, explicit); }

    for (const p of R.preds) {
      if (p.car ? !hasCar : !p.hint.test(sentence)) continue;
      for (const m of sentence.matchAll(p.re)) {
        if (unsure(sentence, m.index)) continue;
        const tail = sentence.slice(Math.max(0, m.index - 100), m.index);
        const t = (p.tail === "poss" ? R.poss : R.subj).exec(tail);
        if (!t) continue;
        if (p.aux && !/(?:'m|'re|'s|\b(?:am|are|is|was|were)\b)/.test(t.groups.aux || "")) continue;
        const s = subjectOf(t.groups, sentence, m.index, p.names);
        if (!s) continue;
        const conf = Math.min(s.conf, p.conf ?? explicit);
        const gr = m.groups;
        if (p.ob === "place") { const pl = cleanRun(gr.pl); if (pl) add(s.ref, p.rel, `place:${pl}`, conf); }
        else if (p.ob === "org") {
          const o = cleanRun(gr.o);
          if (!o) continue;
          const r = p.role || (gr.r && !/\b(?:the|fan|client|customer|friend|member|guest|visitor|meeting|call|job|role|position|week|day|lot|bit)\b/i.test(gr.r) ? gr.r : null);
          if (gr.r && !r) continue;
          add(s.ref, p.rel, `org:${o}`, conf);
          if (r) add(s.ref, "role", `lit:${lower(r)}`, conf);
        } else if (p.ob === "vehicle") {
          const v = vehicleOf(gr);
          if (!v) continue;
          add(s.ref, p.rel, v, conf);
          if (p.rel === "drives") add(s.ref, "owns", v, Math.min(conf, indirect));
        } else if (p.ob === "thing") {
          const th = gr.th.split(/\s+/).filter(w => !OWN_STOP.has(w));
          if (th.length && !OWN_STOP.has(gr.th.split(/\s+/)[0])) add(s.ref, "owns", `lit:${th.join(" ")}`, conf);
        } else if (p.ob === "tool") { const tl = toolOf(gr.t); if (tl) add(s.ref, "uses", tl, conf); }
        else if (p.ob === "phrase") {
          let ph = gr.ph.split(/\s+(?:because|since|when|but|so|as|if)\s+/)[0].trim().replace(/^to\s+/, "");
          if (/^(?:it|that|this|not|you|if|when|them|to be|your|one|either)\b/i.test(ph)) continue;
          ph = ph.split(/\s+/).slice(0, 8).join(" ");
          if (ph) add(s.ref, p.rel, `lit:${ph}`, conf);
        } else if (p.ob === "date") { const d = dateOf(gr); if (d) add(s.ref, "birthday", `lit:${d}`, conf); }
      }
    }
    // "the Volvo needs a service", "my Tesla": a car the user has, said in passing.
    if (hasCar) for (const m of sentence.matchAll(R.mention)) {
      const v = vehicleOf(m.groups);
      if (!v || unsure(sentence, m.index)) continue;
      const the = /^[Tt]he$/.test(m.groups.det);
      if (the && !CARISH.test(sentence.slice(m.index + m[0].length))) continue;
      add("me", "owns", v, indirect);
    }

    if (!assistant && claims.size === before && cues.length < 5 && CUE.test(sentence) && FIRST_PERSON.test(sentence)) cues.push(sentence.slice(0, 300));
  }

  // Selling a car ends owning it: the same turn's passing mention of it is not a claim of owning it.
  for (const c of [...claims.values()]) {
    if (c.rel !== "ended:owns") continue;
    for (const [k, o] of claims) if ((o.rel === "owns" || o.rel === "drives") && o.subj === c.subj && (o.obj === c.obj || o.obj.startsWith(c.obj + " ") || c.obj.startsWith(o.obj + " "))) claims.delete(k);
  }
  const last = cands[cands.length - 1];
  const focus = last ? { ref: last.ref, g: last.g, name: last.name ?? null, age: 0 } : carried;
  return { claims: [...claims.values()], focus, cues };
}

/** The last capitalised run of a comma phrase ("Thanks to Jordan" -> "Jordan"). */
function lastName(n) {
  const w = String(n).split(/\s+/);
  const out = [];
  for (let i = w.length - 1; i >= 0 && out.length < 2 && /^[A-Z]/.test(w[i]) && !OPENERS.has(lower(w[i])); i--) out.unshift(w[i]);
  return out.join(" ");
}
function toolOf(t) {
  const x = trimRun(t);
  if (!x || TOOL_STOP.has(lower(x.split(/\s+/)[0])) || OPENERS.has(lower(x.split(/\s+/)[0]))) return null;
  return `tool:${x}`;
}
