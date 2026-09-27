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
// sold or given up). Two more are evidence the store weighs: `named` (a lowercase word used the
// way names are, "robin and i", "isla's got") and `at` (a person at an organisation, "owen from
// harlow legal", matched against the user's own clients when facts are derived).
//
// People type in lower case. A lowercase word in a name's place ("my partner robin") is read as a
// name only when it is not an ordinary word (./words.js), and only at LOWER confidence: the store
// raises it to explicit when another turn uses the same word as a name.

import { OPENERS, ORG_WORDS } from "../lexicon.js";
import { ordinary } from "./words.js";

/** Confidence per claim by how it was said (docs/work/memory-iq.md, Confidence). */
export const CONF = { explicit: 0.9, indirect: 0.7, model: 0.75, assistant: 0.35 };
/** A lowercase word read as a name, or a lowercase place, before anything else confirms it. */
export const LOWER = 0.45;

/** Roles that name one person: "my wife" is always the same one. */
export const SINGULAR = new Set(["spouse", "partner", "mother", "father"]);

/** Relations where one value holds at a time: a new value competes with the old one. */
export const SINGLE_VALUED = new Set(["name", "birthday", "lives_in", "from", "works_at", "role", "drives", "color", "spouse", "partner", "mother", "father"]);
/** Of those, the ones that change over a life: the newest value is favoured, not just tie-broken. */
export const TIME_VARYING = new Set(["lives_in", "works_at", "role", "drives"]);

/** word -> [role, gender]. Gender only steers she/he; null matches either. */
export const KIN = /** @type {Record<string, [string, "f"|"m"|null]>} */ ({
  wife: ["spouse", "f"], husband: ["spouse", "m"], spouse: ["spouse", null], hubby: ["spouse", "m"], wifey: ["spouse", "f"], missus: ["spouse", "f"],
  partner: ["partner", null], "other half": ["partner", null], "better half": ["partner", null], girlfriend: ["partner", "f"], boyfriend: ["partner", "m"], fiancee: ["partner", "f"], fiance: ["partner", "m"],
  mother: ["mother", "f"], mom: ["mother", "f"], mum: ["mother", "f"], mummy: ["mother", "f"], mommy: ["mother", "f"],
  father: ["father", "m"], dad: ["father", "m"], daddy: ["father", "m"],
  sister: ["sister", "f"], brother: ["brother", "m"], son: ["son", "m"], daughter: ["daughter", "f"],
  kid: ["child", null], kids: ["child", null], child: ["child", null], children: ["child", null],
  dog: ["dog", null], puppy: ["dog", null], cat: ["cat", null], kitten: ["cat", null],
});
const PLURAL = new Set(["kids", "children"]);
/** The relation from me to a relative in that role. */
export const relOfRole = role => (role === "dog" || role === "cat" ? "pet" : role);
const KINW = "wife|husband|spouse|hubby|wifey|missus|partner|other\\s+half|better\\s+half|girlfriend|boyfriend|fianc[eé]e?|mother|mommy|mummy|mom|mum|father|daddy|dad|sister|brother|son|daughter|kids|kid|children|child|dog|puppy|cat|kitten";
/** Words that are always the speaker's own relative, with or without "my". */
const OWN_KIN = /(?<![A-Za-z'])(?<kw>hubby|wifey|missus)\b/gi;
const KINMOD = "lovely|dear|beautiful|amazing|wonderful|older|younger|little|big|baby|eldest|oldest|youngest|middle|two|three|twin|new";
const kinKey = w => w.toLowerCase().replace(/é/g, "e").replace(/\s+/g, " ");

// Car makes: generic brands, the same for everyone, so they may live in code.
const MAKES = ["Alfa Romeo", "Aston Martin", "Land Rover", "Range Rover", "Mercedes-Benz", "Mercedes", "Toyota", "Honda", "Ford",
  "Chevrolet", "Chevy", "Tesla", "Volvo", "BMW", "Audi", "Subaru", "Mazda", "Nissan", "Hyundai", "Kia", "Volkswagen", "VW", "Jeep",
  "Lexus", "Porsche", "Rivian", "Polestar", "Jaguar", "Mini", "Fiat", "Dodge", "GMC", "Cadillac", "Buick", "Acura", "Infiniti",
  "Lincoln", "Mitsubishi", "Skoda", "Peugeot", "Renault", "Citroen", "Genesis", "Lucid", "Prius"];
const MAKE_SET = new Set(MAKES.map(m => m.toLowerCase()));
// Model names people say without the make ("the Outback", "the XC40"). Generic, like the makes.
export const MODELS = /** @type {Record<string, string>} */ ({
  Outback: "Subaru", Forester: "Subaru", Crosstrek: "Subaru", Impreza: "Subaru", "XC40": "Volvo", "XC60": "Volvo", "XC90": "Volvo",
  Civic: "Honda", Accord: "Honda", "CR-V": "Honda", Pilot: "Honda", Camry: "Toyota", Corolla: "Toyota", "RAV4": "Toyota", Tacoma: "Toyota",
  Highlander: "Toyota", Sienna: "Toyota", "F-150": "Ford", Mustang: "Ford", Bronco: "Ford", Explorer: "Ford", Golf: "Volkswagen",
  Jetta: "Volkswagen", Tiguan: "Volkswagen", Wrangler: "Jeep", Cherokee: "Jeep", "CX-5": "Mazda", Miata: "Mazda", Leaf: "Nissan",
  Rogue: "Nissan", Altima: "Nissan", Tucson: "Hyundai", Ioniq: "Hyundai", Sorento: "Kia", Sportage: "Kia", Cayenne: "Porsche", Macan: "Porsche",
});
const COLORS = "black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|gold|purple|maroon|navy|dark\\s+blue|dark\\s+green|dark\\s+grey";
// A capitalised word after a make that says it is a company, not a car ("the Ford Foundation").
const NOT_MODEL = new Set("foundation motor motors company group credit financial finance dealership dealer center centre store stadium arena park inc corp corporation stock shares earnings".split(" "));
/** Letters and digits only, lower case: "CX-5", "cx5" and "Cx 5" are one key. */
const alnum = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
/** Either case for every letter, an optional hyphen: people type "mazda cx5" as often as "Mazda CX-5". */
const anyCase = s => s.replace(/[A-Za-z]/g, ch => `[${ch.toUpperCase()}${ch.toLowerCase()}]`).replace(/-/g, "-?").replace(/\s+/g, "\\s+");
const MAKE_OF = new Map(MAKES.map(m => [m.toLowerCase(), m]));
const MODEL_OF = new Map(Object.keys(MODELS).map(m => [alnum(m), m]));
const MODELS_ANY = Object.keys(MODELS).sort((a, b) => b.length - a.length).map(anyCase).join("|");
const VEHICLE = `(?:(?<col>${COLORS})\\s+)?(?:(?<make>${MAKES.map(anyCase).join("|")})(?:\\s+(?<model>Model\\s+[A-Z0-9]\\b|(?:${MODELS_ANY})\\b|[A-Z0-9][A-Za-z0-9-]*|[a-z]+\\d[a-z0-9-]*))?|(?<solo>${MODELS_ANY})\\b)`;
// Words after "the Volvo" that say it is a car the user has, not a brand in the news.
const CARISH = /^(?:'s\b|\s+(?:is|was|has|had)\b)?\s+(?:needs|need|broke|won't|wont|keeps|got|is\s+in\s+the\s+shop|in\s+the\s+shop|in\s+for|is\s+due|due|service|tires|tyres|battery|brakes|oil|keys|lease|insurance|registration|inspection|repair|parked|still|started|starts|makes|made|making|failed|passed|has\s+a\s+flat|won't\s+start|mot)\b/i;
/** Just before "the Mazda": something done with a car ("parked the cx5", "into the mazda"). */
const CAR_VERB = /\b(?:parked|parking|park|drove|driving|drive|washed|washing|cleaned|cleaning|filled\s+up|into|out\s+of|in\s+the\s+back\s+of|took|taking|take)\s+$/i;
/** "picked up the new car": the car named next in the turn is the user's. */
const NEW_CAR = /\b(?:picked\s+up|pick\s+up|picking\s+up|collected|collecting|got|bought|getting|brought\s+home)\s+(?:the|our|my|a)\s+new\s+(?:car|motor|ride)\b/i;
/** "bye bye civic": the car said goodbye to is gone. */
const BYE_CAR = new RegExp(`\\b(?:bye\\s+bye|goodbye|so\\s+long|farewell)\\s+(?:to\\s+)?(?:the\\s+|my\\s+|our\\s+|old\\s+)*${VEHICLE}`, "g");

// Demonyms and other capitalised adjectives that follow "I'm" or "my wife is" without being names.
const NOT_NAME = new Set(`american british canadian english irish scottish welsh french german italian spanish mexican indian
  pakistani chinese japanese korean australian dutch swedish norwegian danish finnish polish russian brazilian portuguese greek
  turkish african european asian muslim christian jewish catholic hindu buddhist vegan vegetarian ok okay fine back done here
  ready sure happy glad sorry afraid curious`.split(/\s+/));

const NAME = "[A-Z][a-z]*(?:'[A-Z])?[a-z]+(?:-[A-Z][a-z]+)?(?:\\s+[A-Z][a-z]*(?:'[A-Z])?[a-z]+(?:-[A-Z][a-z]+)?)?";
/** One lowercase word where a name could be. lowName() decides whether it is one. */
const LNAME = "[a-z][a-z-]{0,18}[a-z]\\b";
/** A lowercase place: one word that is not an ordinary one, after an optional "new", "san", "st". */
const LPLACE = "(?:(?:new|san|los|las|st|saint|fort|port|north|south|east|west|upper|lower|great|little)\\s+)?[a-z][a-z-]{2,20}\\b";
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
const HYPO = /\b(?:if|suppose|supposing|imagine|imagined|pretend|pretending|hypothetically|assume|assuming|wish|unless|whether|e\.g\.|for example|for instance|let's say|lets say|say that|what if|as though|roleplay|role-play|role play)\b/i;
const NEG_BEFORE = /(?:\bnot|\bnever|\bno|n't|\bnor|\bwithout)\s+(?:\w+\s+){0,1}$/i;
const QUESTION_START = /^(?:what|who|whose|which|where|how)\b|^(?:do|does|did|can|could|would|will|is|are|am)\s+(?:you|i|my|we|it|there|your)\b/i;
const CUE = /\b(?:wife|husband|spouse|partner|girlfriend|boyfriend|fianc\w*|mom|mum|mother|dad|father|sister|brother|son|daughter|kids?|children|dog|cat|car|live|lives|lived|moved|birthday|born|anniversary|drive|drives|married|home|house|apartment|pet)\b/i;
const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|my|we|our|me|us)\b/;
const SECOND_PERSON = /\b(?:you|your|you're|you've)\b/i;

/** What may come before a verb whose subject the user left out: nothing, or an adverb of time. */
const ELLIPSIS = /^(?:(?:just|finally|also|already|recently|today|yesterday|so|and|then|actually|officially)[\s,]+)*$/i;
/** A line that starts dictating someone else's words: "Start with: ...", "Write: ...". */
const DICTATE = /\b(?:start(?:s)?\s+with|write|say|begin\s+with|something\s+like|in\s+(?:his|her|their)\s+own\s+words|draft|copy|persona|reply\s+to\s+this|(?:this|the|an?)\s+(?:email|message|note|text|letter|reply)(?:\s+from\s+[\w.' -]{1,40})?|this\s+from\s+[\w.' -]{1,40}|here(?:'s|\s+is)\s+what\s+(?:he|she|they)\s+(?:said|wrote|sent)|(?:reply|respond|answer)\s+to\s+[\w.' -]{1,40}|(?:came\s+in|arrived|got\s+this)\s+from\s+[\w.' -]{1,40}|wrote|writes|forwarded(?:\s+message)?|(?:proofread|rewrite|reword|tidy|fix|polish|edit|translate|summari[sz]e|shorten)\s+(?:up\s+)?(?:this|these|the\s+following|it|below)|(?:copy|draft|email|message|letter|reply|persona|bio|post|caption|tweet|headline|paragraph|wording|script|intro|blurb|testimonial|template)\b[^:\n]{0,60})\s*:|-{3,}\s*forwarded\s+message/i;
/** A line that opens a message to someone by name: "Hi Juno,", "Dear Mrs Holt,". */
const GREETING = /^\s*["']?(?:Hi|Hello|Hey|Dear|Morning|Afternoon)\s+(?!(?:Claude|Vyre|There|All|Team|Everyone|Guys|Folks|Both)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*[,!]/;
/** Its sign-off: "Best, Owen", "Thanks, Juno Hale", "Kind regards". */
const SIGNOFF = /\b(?:Best|Thanks|Thank you|Cheers|Regards|Kind regards|Best wishes|Warm regards|Sincerely|Yours|All the best),?\s+[A-Z][a-z]+/;
/** Someone else speaking in the first person: "I, Tomas Park, am ...". */
const OTHER_I = /(?:^|[\s:"])I,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,/;

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
  // "our cat", "our son": a relative is ours as much as mine.
  const MYK = u ? "[Mm]y|[Oo]ur" : "[Yy]our";
  const I = u ? "I|i|[Ww]e" : "[Yy]ou";
  // A lowercase word in a name's place, for the user's own lowercase typing. Checked by lowName().
  const LN = u ? `|(?<ln>${LNAME})` : "";
  const kinP = `(?:${MYK})\\s+(?:(?:${KINMOD})\\s+)?(?<kw>${KINW})`;
  const g = s => new RegExp(s, "g");
  return {
    // Subject right before a predicate: "I", "we", "she", "my wife", "my wife Jordan", "Jordan".
    subj: new RegExp(`(?:^|[\\s,;:(])(?:(?<i>${I})|(?<p>[Ss]he|[Hh]e)|(?:${MYK})\\s+(?:(?:${KINMOD})\\s+)?(?<k>${KINW})(?:,?\\s+(?<kn>${NAME}),?)?|(?<n>${NAME})${LN})(?<aux>(?:'m|'re|'s|'ve|\\s+(?:am|are|is|was|were|have|has|had|also|still|now|currently|actually|originally|both|all|just|finally|recently|already))*)\\s+$`),
    // Possessor right before a noun: "my", "our", "her", "my wife's", "Jordan's".
    poss: new RegExp(`(?:^|[\\s,;:(])(?:(?<i>${MYOUR})|(?<p>[Hh]er|[Hh]is)|(?:${MYK})\\s+(?:(?:${KINMOD})\\s+)?(?<k>${KINW})(?:\\s+(?<kn>${NAME}))?'s|(?:(?<n>${NAME})${LN})'s)\\s+$`),
    kin: g(`(?<![A-Za-z'])${kinP}\\b(?!'s|-)`),
    kinName: g(`(?<![A-Za-z'])${kinP}'s\\s+name\\s+is\\s+(?:(?<n>${NAME})${LN})`),
    nameParen: g(`(?<![A-Za-z'])(?:(?<n>${NAME})${LN})\\s*\\(\\s*${kinP}\\s*\\)`),
    // "dad (Graham)", "my son (theo)": the relative, then the name in brackets.
    kinParen: g(`(?<![A-Za-z'])(?<pre>(?:${MYK})\\s+)?(?<kw>${KINW})\\s*\\(\\s*(?:(?<n>${NAME})${LN})\\s*\\)`),
    nameComma: g(`(?<n>${NAME}),\\s+${kinP}\\b(?!'s)(?=\\s*(?:[,.;:!)]|$))`),
    lowComma: g(`(?<![\\w'])(?<ln>${LNAME}),\\s+${kinP}\\b(?!'s)(?=\\s*(?:[,.;:!)]|$))`),
    myName: g(`\\b${MY}\\s+name(?:'s|\\s+is)\\s+(?<n>${NAME})`),
    imName: new RegExp(`^(?:(?:[Hh]i|[Hh]ello|[Hh]ey)[,!]?\\s+)?(?:I'm|I\\s+am|[Cc]all\\s+me)\\s+(?<n>${NAME})(?=\\s*(?:[,.!;:]|and\\b|$))`),
    myCar: g(`\\b${MY}\\s+(?:car|ride)(?:'s|\\s+is)\\s+(?:a|an)\\s+(?:(?:new|used|old)\\s+)?(?:(?:19|20)\\d\\d\\s+)?${VEHICLE}`),
    myEditor: g(`\\b${MY}\\s+(?:code\\s+|text\\s+)?editor(?:\\s+of\\s+choice)?\\s+is\\s+(?<t>${TOOL})`),
    clientIs: g(`(?<o>${ORG})\\s+(?:is|are)\\s+(?:a|an|our|my|${MY})\\s+(?:(?:new|big|biggest|long-?time|key|good|great)\\s+)?client\\b`),
    myCompany: g(`\\b${MY}\\s+(?:own\\s+)?(?:company|studio|firm|agency|business|startup|consultancy|practice|shop),?\\s+(?<o>${ORG})`),
    atOrgWe: new RegExp(`^(?:[Hh]ere\\s+)?[Aa]t\\s+(?<o>${ORG}),?\\s+(?:${I})\\s+[a-z]`),
    ourClient: g(`\\b(?:${MYOUR})\\s+(?:(?:new|big|biggest|key)\\s+)?client,?\\s+(?<o>${ORG})`),
    mention: g(`(?<![A-Za-z])(?<det>${MYOUR}|[Tt]he)\\s+${VEHICLE}\\b`),
    // Predicates. subj: which tail must precede; aux: the tail must carry a be-verb ("I'm from").
    preds: [
      { hint: /\b(?:live|lives|living|reside|resides|based|settled)\b/, re: g(`\\b(?:live|lives|living|reside|resides|based|settled)\\s+in\\s+(?:the\\s+)?(?<pl>${PLACE})`), rel: "lives_in", ob: "place", tail: "subj" },
      { hint: /\b(?:moved|relocated)\b/, re: g(`\\b(?:moved|relocated)\\s+(?:back\\s+|over\\s+|out\\s+)?(?:from\\s+${PLACE}\\s+)?to\\s+(?<pl>${PLACE})`), rel: "lives_in", ob: "place", tail: "subj" },
      // The same in lower case: a place is any word that is not an ordinary one, so it is held
      // loosely ("moved to neovim" is a tool) until another turn says the same place.
      ...(u ? [
        { hint: /\b(?:live|living|based|settled)\s+in\s+[a-z]/, re: g(`\\b(?:live|lives|living|based|settled)\\s+in\\s+(?<lpl>${LPLACE})`), rel: "lives_in", ob: "place", tail: "subj", conf: CONF.indirect },
        { hint: /\b(?:moved|relocated)\s+(?:back\s+|over\s+|up\s+|down\s+)?to\s+[a-z]/, re: g(`\\b(?:moved|relocated)\\s+(?:back\\s+|over\\s+|up\\s+|down\\s+)?to\\s+(?<lpl>${LPLACE})`), rel: "lives_in", ob: "place", tail: "subj", conf: LOWER },
        { hint: /\b(?:originally|grew|born)\b/, re: g(`\\b(?:originally\\s+from|grew\\s+up\\s+in|born\\s+and\\s+raised\\s+in|was\\s+born\\s+in)\\s+(?<lpl>${LPLACE})`), rel: "from", ob: "place", tail: "subj", conf: CONF.indirect },
        // "i work for harlow legal": lowercase, so held loosely (a client is often "worked for" too).
        { hint: /\bwork(?:s|ing)?\s+(?:at|for)\s+[a-z]/, re: g(`\\b(?:work|works|working)\\s+(?:at|for)\\s+(?<lo>[a-z][\\w&'-]*(?:\\s+[a-z][\\w&'-]*){0,3})`), rel: "works_at", ob: "org", tail: "subj", conf: LOWER },
      ] : []),
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
      { hint: /\b(?:birthday|bday|b-day)\b/, re: g(`\\b(?:birthday|bday|b-day)(?:'s|\\s+is|\\s+falls)?\\s+(?:is\\s+)?(?:on\\s+)?(?:the\\s+)?${DATE}`), rel: "birthday", ob: "date", tail: "poss", names: true },
    ],
  };
}
const RX = { user: build("user"), assistant: build("assistant") };
/** What may follow "my wife" to name her: "Jordan", ", Jordan,", "is Jordan", "called Jordan"; "my kids Sam and Juno". */
const AFTER = {
  list: new RegExp(`^,?\\s+(${NAME}(?:,\\s*${NAME})*(?:,?\\s+and\\s+${NAME})?)`),
  one: new RegExp(`^,?\\s+(${NAME})(?=[\\s,.!?;:)]|'s|$)`),
  // The user's lowercase: "my partner robin says", "our cat pepper", "my kids theo and isla".
  lower: new RegExp(`^,?\\s+(${LNAME})(?=[\\s,.!?;:)]|'s|$)`),
  lowerList: new RegExp(`^,?\\s+(${LNAME}(?:,\\s*${LNAME})*,?\\s+(?:and|&)\\s+${LNAME})(?=[\\s,.!?;:)]|'s|$)`),
  is: new RegExp(`^\\s+(?:is|'s)\\s+(?:called\\s+|named\\s+)?(${NAME})(?=\\s*(?:[,.!;:]|and\\b|$))`),
  called: new RegExp(`^,?\\s+(?:called|named)\\s+(${NAME})`),
};
// Cheap tests that decide which rules a sentence can need at all. Most turns are about code and
// pass none of them, which is what keeps a first pass over a large history fast.
const HAS_KIN = new RegExp(`\\b(?:${KINW})\\b`, "i");
/** First words of every make and model: a sentence with none of them names no car. A set lookup per
 * capitalised word is far cheaper than one alternation of a hundred names on every sentence. */
const CAR_WORDS = new Set([...MAKES, ...Object.keys(MODELS)].map(m => alnum(m.split(/[\s]/)[0])));
const hasCarWord = s => { for (const w of s.match(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)?/g) || []) if (CAR_WORDS.has(alnum(w))) return true; return false; };
const HAS_COMPANY = /\b(?:company|studio|firm|agency|business|startup|consultancy|practice|shop)\b/;
const HAS_NAME = /\bname\b|\bI'm\s+[A-Z]|\bI\s+am\s+[A-Z]|\b[Cc]all\s+me\s/;

/** Makes and models that are also ordinary words or names: in lower case they need a car's context. */
const AMBIG_CAR = new Set("mini golf leaf pilot explorer accord rogue genesis lincoln jaguar mustang bronco cherokee fiat dodge lucid civic sienna tucson cayenne wrangler ford mercedes jeep focus".split(" "));
/** Right before a word: someone else owns it, or it is a common noun ("sophie's husband", "the robin's"). */
const OTHERS_BEFORE = /(?:'s|\b(?:his|her|their|your|ur|a|an|the|any|every|each|no|whose|this|that)\b)\s*$/i;
/** A bare relative's word opening the sentence as its subject: "partner's away", "dad (Graham) is visiting". */
/** Words that may open a sentence before its subject. */
const OPENING = /^(?:(?:so|and|but|also|ok|okay|oh|well|sorry|lol|ugh|just|then|plus|btw|fyi|anyway)[\s,]+)*$/i;
const BARE_KIN = new RegExp(`^(?:(?:so|and|but|also|ok|okay|oh|well|sorry|lol|ugh|just|then|plus|btw|fyi|anyway)[\\s,]+)*(?<kw>${KINW})(?='s\\b|\\s*\\(|\\s+(?:is|are|was|were|has|had|have|and|just|will|won't|can't|isn't|wasn't|got|made|took|left|came|went|[a-z]+(?:s|ed))\\b)`, "i");
// A lowercase word used the way names are: "robin and i", "isla's got", "theo (he's 9)",
// "pepper hates the new house, she's ...". Evidence the store weighs, never a fact.
const NAMED_AND = /(?<![\w'])(?<n>[a-z][a-z-]+)\s+and\s+(?:[iI]|me)\b/g;
const NAMED_POSS = /(?<![\w'])(?<n>[a-z][a-z-]+)'s\b/g;
const NAMED_PAREN = /(?<![\w'])(?<n>[a-z][a-z-]+)\s*\(\s*(?:he|she)(?:'s|\s+is|\s+was)\b/g;
const NAMED_START = /^(?<n>[a-z][a-z-]+)\s+(?:is|was|has|had|[a-z]+s|[a-z]+ed)\b.*\b(?:she|he)(?:'s)?\b/g;
const NAMED = [NAMED_AND, NAMED_POSS, NAMED_PAREN, NAMED_START];
/** What may come before a clause whose subject is the user, left out or plain. */
const SELF_BEFORE = /(?:^|[,;:]\s*|\b(?:and|but|so|lol|tbh|honestly)\s+)(?:(?:i'm|im|i\s+am|we're|we\s+are|i've|ive|i|we|still|slowly|finally|just|really|all|also|now|kind\s+of|sort\s+of)\s+)*$/i;
const PLACE_X = `(?:(?<pl>${PLACE})|(?<lpl>${LPLACE}))`;
/** Where the user lives, said in passing. self: the words before must leave the user as the subject. */
const PLACE_RULES = /** @type {{ re: RegExp, conf: number, lconf: number, self?: boolean }[]} */ ([
  { re: new RegExp(`\\b(?:the|our|my)\\s+(?:big\\s+)?move\\s+(?:away\\s+)?(?:from|out\\s+of)\\s+${PLACE_X}`, "g"), conf: LOWER, lconf: LOWER },
  { re: new RegExp(`\\b(?:i'm|im|we're|i\\s+am|we\\s+are)\\s+(?:finally\\s+|officially\\s+)?moving\\s+(?:away\\s+)?(?:from|out\\s+of)\\s+${PLACE_X}`, "g"), conf: LOWER, lconf: LOWER },
  { re: new RegExp(`\\b(?:getting|got|get)\\s+used\\s+to\\s+(?:living\\s+in\\s+|life\\s+in\\s+)?${PLACE_X}`, "g"), conf: LOWER, lconf: LOWER, self: true },
  { re: new RegExp(`\\b(?:the|our|my)\\s+new\\s+(?:place|house|flat|home|apartment|pad)\\s+(?:up\\s+|down\\s+|over\\s+)?in\\s+${PLACE_X}`, "g"), conf: CONF.indirect, lconf: CONF.indirect },
  { re: new RegExp(`\\b(?:our|my)\\s+(?:place|house|flat|home|apartment)\\s+in\\s+${PLACE_X}`, "g"), conf: CONF.indirect, lconf: CONF.indirect },
]);
/** Occupations: generic nouns, the same for everyone. "im a freelance designer". */
const OCC = `designer|developer|engineer|programmer|coder|lawyer|attorney|solicitor|barrister|paralegal|accountant|bookkeeper|teacher|lecturer|professor|tutor|nurse|doctor|gp|dentist|surgeon|vet|pharmacist|therapist|counsellor|counselor|writer|author|journalist|copywriter|photographer|illustrator|artist|animator|architect|consultant|contractor|freelancer|founder|co-founder|cofounder|ceo|cto|cfo|coo|manager|director|analyst|researcher|scientist|student|marketer|baker|chef|cook|electrician|plumber|builder|carpenter|mechanic|recruiter|realtor|producer|musician|translator|coach|trainer|administrator|strategist|planner|editor|entrepreneur|owner|investor|economist|statistician|technician|paramedic|firefighter|officer|pilot|farmer|florist|hairdresser|stylist`;
const ROLE_RE = new RegExp(`\\b(?:i'm|im|i\\s+am|i\\s+work\\s+as)\\s+(?:a|an)\\s+(?<r>(?:[a-z-]+\\s+){0,2}(?:${OCC}))\\b(?!\\s+(?:at|for)\\b)`, "gi");
/** "i keep all my notes in obsidian": the tool a kind of thing lives in. */
const KEEP_IN = /\b(?:keep|kept|write|take|store|put|track|jot)\s+(?:down\s+)?(?:all\s+|most\s+)?(?:of\s+)?(?:my|our)\s+(?<what>[a-z]+(?:\s+[a-z]+)?)\s+in\s+(?<t>[A-Za-z][\w.+#-]*)/gi;
/** "im a freelance designer, mostly figma": the tool of a statement about the user's work. */
const MOSTLY = /[,;]\s*(?:but\s+)?(?:mostly|mainly|usually|primarily)\s+(?:in\s+|on\s+|with\s+|using\s+|use\s+)?(?<t>[A-Za-z][\w.+#-]*)\b/gi;
/** "my two clients right now are harlow legal and northwind bakery". */
const CLIENT_LIST = /\b(?:my|our)\s+(?:(?:two|three|four|five|\d+|main|current|biggest|big|regular|only|active|key)\s+)*clients?\s+(?:right\s+now\s+|at\s+the\s+moment\s+|currently\s+|these\s+days\s+|now\s+|atm\s+)?(?:are|is|include|:)\s+(?<list>[^.;!?]+)/gi;
/** "owen from harlow legal", "bea at northwind bakery": a person at an organisation, kept raw for the store. */
const AT_RE = new RegExp(`(?<![\\w'])(?<n>[a-z][a-z-]+|${NAME})\\s+(?:from|at|@)\\s+(?<o>[A-Za-z0-9][\\w&'.-]*(?:\\s+[\\w&'.-]+){0,3})`, "g");
const VEHICLE_ONE = new RegExp(VEHICLE);
const LOW_CLIENT = /\b(?:my|our)\s+(?:(?:new|big|biggest|key|main|favourite|favorite|latest)\s+)?client,?\s+(?:called\s+|named\s+|is\s+)?(?<lo>[a-z][\w&'-]*(?:\s+[a-z][\w&'-]*){0,3})/g;
const LOW_CLIENT_IS = /(?<lo>(?:[a-z][\w&'-]*\s+){1,4})(?:is|are)\s+(?:a|an|my|our)\s+(?:(?:new|big|biggest|long-?time|key|good|great|main|favourite|favorite)\s+)?client\b/g;

const lower = s => s.toLowerCase();
/** Drops leading words that open sentences ("Yesterday Jordan" is Jordan) and any trailing opener. */
function cleanName(n) {
  const w = String(n || "").split(/\s+/).filter(Boolean);
  while (w.length && OPENERS.has(lower(w[0]))) w.shift();
  while (w.length > 1 && OPENERS.has(lower(w[w.length - 1]))) w.pop();
  if (!w.length || NOT_NAME.has(lower(w[0])) || MAKE_SET.has(lower(w[0]))) return null;
  return w.join(" ");
}
const cap1 = w => w.charAt(0).toUpperCase() + w.slice(1);
/** Words that are never a name, whatever their case: kin words, makes, models, months. */
const NEVER_NAME = new Set([...Object.keys(KIN), ...MAKE_SET, ...[...MODEL_OF.keys()], ...MONTHS, "claude", "vyre"]);
/** A lowercase word read as a name ("robin" -> "Robin"), or null when it is an ordinary word. */
function lowName(w) {
  const x = String(w || "").toLowerCase();
  if (x.length < 3 || /-$|^-/.test(x) || ordinary(x) || NEVER_NAME.has(x) || NOT_NAME.has(x) || OPENERS.has(x)) return null;
  return x.split("-").map(cap1).join("-");
}
/** A lowercase place ("leeds" -> "Leeds", "new york" -> "New York"), or null. */
function lowPlace(p) {
  const w = String(p || "").toLowerCase().split(/\s+/).filter(Boolean);
  const last = w[w.length - 1];
  if (!last || last.length < 3 || ordinary(last) || NEVER_NAME.has(last) || OPENERS.has(last)) return null;
  return w.map(cap1).join(" ");
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
  if (gr.solo) { const k = MODEL_OF.get(alnum(gr.solo)); return k ? `vehicle:${MODELS[k]} ${k}` : null; }
  if (!gr.make) return null;
  const make = MAKE_OF.get(gr.make.toLowerCase().replace(/\s+/g, " ")) || gr.make;
  let model = gr.model || "";
  if (model && NOT_MODEL.has(lower(model))) return null;
  if (model && (OPENERS.has(lower(model)) || MAKE_SET.has(lower(model)))) model = "";
  // A known model in its usual spelling ("cx5" is "CX-5"); any other lowercase one only with a digit.
  if (model) model = MODEL_OF.get(alnum(model)) || (/^[a-z]/.test(model) ? model.toUpperCase() : model);
  return `vehicle:${make}${model ? " " + model : ""}`;
}

/**
 * The text worth reading: no code, no quoted or pasted material, no letter someone pasted in.
 * @param {string} text
 * @param {"user"|"assistant"} who
 */
function readable(text, who) {
  let t = String(text).replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/"""[\s\S]*?(?:"""|$)/g, "\n").replace(/`[^`\n]*`/g, " ");
  // Quoted words are someone else's, or copy being written: a pasted email in "...", a draft in
  // '...'. An apostrophe inside a word ("robin's", "it's") neither opens nor closes a quote.
  if (t.includes('"')) t = t.replace(/(^|[\s:(\[])"[^"]*(?:"|$)/g, "$1\n");
  if (t.includes("'")) t = t.replace(/(^|[\s:(\[])'(?=[A-Za-z])(?:[^'\n]|'(?=[a-z]))*'(?=[\s.,;:!?)\]]|$)/g, "$1\n");
  const out = [];
  let letter = false, sig = 0, first = true;
  for (const line of t.split("\n")) {
    if (sig > 0) { sig--; if (line.trim().length < 40) continue; }
    if (/^\s*>/.test(line) || /^\s*(?:From|To|Cc|Bcc|Subject|Date|Sent):\s/.test(line)) continue;
    if (!letter && /^\s*(?:Dear\s+[^\n]{1,60}|To whom it may concern)[,:]?\s*$/i.test(line)) { letter = true; continue; }
    // A pasted message that opens with a greeting to someone by name, after the user's own first
    // line: "Hi Juno, thanks for ..." up to its sign-off, or to the end of the turn.
    if (!letter && !first && GREETING.test(line)) { letter = !SIGNOFF.test(line); if (!letter) sig = 0; continue; }
    if (line.trim()) first = false;
    if (letter) {
      if (/^\s*(?:Sincerely|Best regards|Kind regards|Warm regards|Regards|Yours sincerely|Yours truly|Yours faithfully|Respectfully|Best|Cheers|Thank you|Thanks)[,.!]?\s*$/i.test(line)) { letter = false; sig = 2; }
      continue;
    }
    out.push(line);
  }
  // Sentences end at . ! ? before any letter: lowercase typing starts sentences in lowercase.
  let s = out.join("\n").split(/(?<!\b(?:e\.g|i\.e|etc|vs|[Mm]r|[Mm]rs|[Mm]s|[Dd]r|[Ss]t|approx|[A-Za-z])\.)(?<=[.!?])\s+(?=[A-Za-z"'(])|\n+/).map(x => x.trim()).filter(Boolean);
  // Dictated words are someone else's: from "Start with:" (or "I, <Name>,") to the end of the turn.
  const cut = t.includes(":") || t.includes("I,") ? s.findIndex(x => DICTATE.test(x) || OTHER_I.test(x)) : -1;
  if (cut >= 0) {
    const m = DICTATE.exec(s[cut]);
    s = [...s.slice(0, cut), ...(m ? [s[cut].slice(0, m.index).trim()].filter(Boolean) : [])];
  }
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
  const add = (subj, rel, obj, conf, how = null) => {
    const k = `${subj}|${rel}|${obj}`;
    const c = claims.get(k);
    if (!c || c.conf < conf) claims.set(k, { subj, rel, obj, conf, method: assistant ? method : how || (conf === CONF.indirect ? "indirect" : method) });
  };
  /**
   * A car claim, and its colour when one was said ("a blue Volvo XC40"). strong: the words around
   * it say it is a car. Without that, a lowercase word that is also an ordinary one ("my mini
   * break", "golf") is not read as a car.
   */
  const car = (subj, rel, gr, conf, strong = true) => {
    const v = vehicleOf(gr);
    if (!v) return null;
    if (!strong && !gr.col && !(gr.make && gr.model) && !/[A-Z]/.test((gr.make || "") + (gr.solo || "")) && AMBIG_CAR.has(alnum(gr.make || gr.solo || ""))) return null;
    add(subj, rel, v, conf);
    if (gr.col && rel !== "ended:owns") add(v, "color", `lit:${lower(gr.col).replace(/\s+/g, " ")}`, conf);
    return v;
  };
  /** Names said this turn: name (and first name) -> the reference it stands for. */
  const names = new Map();
  /** People mentioned this turn, in order: who "she" and "he" can mean. */
  /** @type {Focus[]} */
  const cands = [];
  const cues = [];

  /** Link a relative: "my wife" (no names), "my wife Jordan", "my kids Sam and Juno". Returns the reference. */
  const kin = (word, list, conf, how = null) => {
    const key = kinKey(word);
    const k = KIN[key];
    if (!k) return null;
    const [roleName, g] = k;
    const kref = `kin:${roleName}`;
    const named = list.map(cleanName).filter(Boolean);
    // A lowercase name is held at LOWER until another turn confirms it; the link to the relative
    // is as sure as "my partner" alone.
    const link = how === "lower" ? Math.min(conf, indirect) : named.length ? conf : Math.min(conf, indirect);
    add("me", relOfRole(roleName), kref, link);
    add(kref, "called", `lit:${lower(word)}`, link);
    let ref = kref;
    for (const n of /** @type {string[]} */ (named)) {
      add(kref, "name", `lit:${n}`, how === "lower" ? Math.min(conf, LOWER) : conf, how);
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
    if (gr.n || gr.ln) {
      const n = gr.n ? cleanName(gr.n) : lowName(gr.ln);
      if (!n) return null;
      const known = names.get(n) || names.get(n.split(" ")[0]);
      if (known) return { ref: known.ref, conf: explicit };
      if (prevF?.name && (prevF.name === n || prevF.name.split(" ")[0] === n)) return { ref: prevF.ref, conf: explicit };
      return allowName ? { ref: `name:${n}`, conf: gr.n ? explicit : indirect } : null;
    }
    return null;
  };

  /**
   * The names that follow a relative's word: "Jordan", ", Jordan,", "is Jordan", "called Jordan",
   * "Sam and Juno"; in the user's lowercase, "robin" or "theo and isla" (how: "lower").
   * @param {string} word @param {string} rest  the text after the word
   * @returns {{ list: string[], how: string|null }}
   */
  const namesAfter = (word, rest) => {
    const plural = PLURAL.has(kinKey(word));
    let nm;
    if (plural && (nm = AFTER.list.exec(rest))) return { list: nm[1].split(/\s*,\s*|\s+and\s+/), how: null };
    for (const re of [AFTER.one, AFTER.is, AFTER.called]) if ((nm = re.exec(rest))) return { list: [nm[1]], how: null };
    if (assistant) return { list: [], how: null };
    if (plural && (nm = AFTER.lowerList.exec(rest))) {
      const l = nm[1].split(/\s*,\s*|\s+(?:and|&)\s+/).map(lowName);
      if (l.every(Boolean)) return { list: /** @type {string[]} */ (l), how: "lower" };
    }
    if ((nm = AFTER.lower.exec(rest))) { const n = lowName(nm[1]); if (n) return { list: [n], how: "lower" }; }
    return { list: [], how: null };
  };
  /** Link a relative whose word ends at `end` of the sentence, with any names after it. */
  const kinAt = (word, sentence, end, conf) => {
    const rest = sentence.slice(end);
    // "my wife isn't Jordan", "my wife was never ...": said about her, but denied.
    if (/^\s+(?:isn't|is\s+not|wasn't|was\s+not|never)\b/.test(rest)) return null;
    const { list, how } = namesAfter(word, rest);
    return kin(word, list.filter(n => cleanName(n)), conf, how);
  };

  /** Is the match at idx negated, hypothetical, or inside a question's clause? */
  const unsure = (sentence, idx) => {
    const before = sentence.slice(0, idx);
    const clause = before.slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf(":")) + 1);
    return HYPO.test(clause) || NEG_BEFORE.test(before.slice(-24)) || /\b(?:would|could|might)\s+be\b/.test(sentence.slice(idx, idx + 60));
  };

  /** A tool named in lower case, or not: "figma" is "Figma"; an ordinary word is none. */
  const toolName = t => {
    const x = trimRun(t);
    if (!x) return null;
    if (/^[A-Z]/.test(x)) return OPENERS.has(lower(x)) || TOOL_STOP.has(lower(x)) ? null : `tool:${x}`;
    const n = lowName(x);
    return n ? `tool:${n}` : null;
  };
  /** An organisation named in a list: "harlow legal" -> "Harlow Legal". Stops at an ordinary word. */
  const orgName = item => {
    const w = String(item).trim().split(/\s+/).filter(Boolean);
    if (!w.length) return null;
    const first = w[0];
    if (/^[a-z]/.test(first) ? !lowName(first) : OPENERS.has(lower(first))) return null;
    const out = [first];
    for (const x of w.slice(1, 4)) { if (ordinary(x) && !ORG_WORDS.has(lower(x))) break; out.push(x); }
    return out.map(x => (/^[a-z]/.test(x) ? cap1(x) : x)).join(" ");
  };
  /** The organisation named just before "is my client": the last words that are not ordinary ones. */
  const orgBefore = run => {
    const w = String(run).trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = w.length - 1; i >= 0 && out.length < 4; i--) {
      const x = w[i], l = lower(x);
      if (!(ORG_WORDS.has(l) || (/^[a-z]/.test(x) ? lowName(x) : !OPENERS.has(l)))) break;
      out.unshift(x);
    }
    // It must start with a word of its own, not a kind of business ("legal is my client").
    while (out.length && /^[a-z]/.test(out[0]) && (!lowName(out[0]) || ORG_WORDS.has(out[0]))) out.shift();
    return out.length ? out.map(x => (/^[a-z]/.test(x) ? cap1(x) : x)).join(" ") : null;
  };
  /** The rules for how people type in lower case and in passing: places, work, tools, clients, cars. */
  const personalLower = (sentence, ls, si) => {
    if (/\b(?:move|moving|used\s+to|place|house|flat|home|apartment|pad)\b/.test(ls)) for (const r of PLACE_RULES) for (const m of sentence.matchAll(r.re)) {
      if (unsure(sentence, m.index)) continue;
      if (r.self && !SELF_BEFORE.test(sentence.slice(0, m.index))) continue;
      const pl = m.groups.pl ? cleanRun(m.groups.pl) : lowPlace(m.groups.lpl);
      if (!pl) continue;
      const conf = m.groups.pl ? r.conf : r.lconf;
      add("me", "lives_in", `place:${pl}`, conf, conf <= LOWER ? "lower" : null);
    }
    if (/\b(?:i'm|im|i am|work as)\s+an?\s/.test(ls)) for (const m of sentence.matchAll(ROLE_RE)) {
      if (unsure(sentence, m.index)) continue;
      add("me", "role", `lit:${lower(m.groups.r).replace(/\s+/g, " ")}`, explicit);
    }
    if (/\b(?:my|our)\b/.test(ls) && /\sin\s/.test(ls)) for (const m of sentence.matchAll(KEEP_IN)) {
      if (unsure(sentence, m.index) || !SELF_BEFORE.test(sentence.slice(0, m.index))) continue;
      const t = toolName(m.groups.t);
      if (t) add("me", "uses", t, indirect);
    }
    if (/\b(?:mostly|mainly|usually|primarily)\b/.test(ls) && /\b(?:i|i'm|im|my)\b/.test(ls)) for (const m of sentence.matchAll(MOSTLY)) {
      if (unsure(sentence, m.index)) continue;
      const t = toolName(m.groups.t);
      if (t) add("me", "uses", t, indirect);
    }
    if (ls.includes("client")) for (const m of sentence.matchAll(CLIENT_LIST)) {
      if (unsure(sentence, m.index)) continue;
      for (const item of m.groups.list.split(/\s*,\s*|\s+(?:and|&)\s+/)) {
        const o = orgName(item);
        if (!o) break;
        add("me", "client", `org:${o}`, explicit);
      }
    }
    if (ls.includes("client")) {
      // "our new client, harlow legal", "harlow legal is my biggest client".
      for (const m of sentence.matchAll(LOW_CLIENT)) { if (unsure(sentence, m.index)) continue; const o = orgName(m.groups.lo); if (o) add("me", "client", `org:${o}`, explicit); }
      for (const m of sentence.matchAll(LOW_CLIENT_IS)) { if (unsure(sentence, m.index)) continue; const o = orgBefore(m.groups.lo); if (o) add("me", "client", `org:${o}`, explicit); }
    }
    if (/\s(?:from|at|@)\s/.test(ls)) for (const m of sentence.matchAll(AT_RE)) {
      if (OTHERS_BEFORE.test(sentence.slice(Math.max(0, m.index - 16), m.index))) continue;
      const n = /^[A-Z]/.test(m.groups.n) ? cleanName(m.groups.n) : lowName(m.groups.n);
      if (n) add(`name:${n}`, "at", `lit:${lower(m.groups.o)}`, indirect, "at");
    }
    // "just picked up the new car!! red mazda cx-5": the car named next in the turn.
    if (ls.includes("new ")) { const m = NEW_CAR.exec(sentence); if (m && !unsure(sentence, m.index) && SELF_BEFORE.test(sentence.slice(0, m.index))) {
      const v = VEHICLE_ONE.exec(sentence.slice(m.index + m[0].length) + " " + (sentences[si + 1] || ""));
      if (v) car("me", "owns", v.groups, indirect, true);
    } }
    if (/\b(?:bye|goodbye|so long|farewell)\b/.test(ls)) for (const m of sentence.matchAll(BYE_CAR)) car("me", "ended:owns", m.groups, indirect, true);
  };

  const sentences = readable(text, who);
  for (let si = 0; si < sentences.length; si++) {
    let sentence = sentences[si];
    const before = claims.size;
    if (/\?\s*["')]*$/.test(sentence) && !QUESTION_START.test(sentence)) {
      // "my partner robin says the logo looks too corporate, thoughts?": a statement with a short
      // question tagged on. The statement still counts.
      const tag = /^(.*[^\s,;])\s*[,;]\s*[^,;?]{1,40}\?+\s*["')]*$/.exec(sentence);
      if (tag && !tag[1].includes("?")) sentence = tag[1];
    }
    const question = /\?\s*["')]*$/.test(sentence) || QUESTION_START.test(sentence);
    if (question) continue;

    const hasKin = HAS_KIN.test(sentence), hasCar = hasCarWord(sentence);
    const ls = assistant ? "" : sentence.toLowerCase();
    // Names first, so a subject later in the sentence can use them.
    if (hasKin) {
    for (const m of sentence.matchAll(R.kinName)) if (!unsure(sentence, m.index)) {
      if (m.groups.n) kin(m.groups.kw, [m.groups.n], explicit);
      else { const n = lowName(m.groups.ln); if (n) kin(m.groups.kw, [n], explicit); }   // "my son's name is theo" says it outright
    }
    for (const m of sentence.matchAll(R.nameParen)) if (!unsure(sentence, m.index)) {
      // A name beside its relative in brackets is as plain as it gets, even in lower case.
      const n = m.groups.n || lowName(m.groups.ln);
      if (n) kin(m.groups.kw, [n], m.groups.n ? explicit : indirect);
    }
    if (!assistant) for (const m of sentence.matchAll(R.kinParen)) {
      if (unsure(sentence, m.index)) continue;
      // "dad (Graham)" with no "my" is the user's dad only as the sentence's opening subject: in a
      // list ("Owen, wife (Claire)") it is someone else's.
      if (!m.groups.pre && !OPENING.test(sentence.slice(0, m.index))) continue;
      const n = m.groups.n || lowName(m.groups.ln);
      if (n) kin(m.groups.kw, [n], m.groups.n ? explicit : indirect);
    }
    for (const m of sentence.matchAll(R.nameComma)) if (!unsure(sentence, m.index)) kin(m.groups.kw, [lastName(m.groups.n)], explicit);
    if (!assistant) for (const m of sentence.matchAll(R.lowComma)) { const n = lowName(m.groups.ln); if (n && !unsure(sentence, m.index)) kin(m.groups.kw, [n], explicit, "lower"); }
    for (const m of sentence.matchAll(R.kin)) {
      if (unsure(sentence, m.index)) continue;
      kinAt(m.groups.kw, sentence, m.index + m[0].length, explicit);
    }
    if (!assistant) {
      // "hubby's cooking tonight": a word that is only ever one's own.
      for (const m of sentence.matchAll(OWN_KIN)) {
        if (unsure(sentence, m.index) || OTHERS_BEFORE.test(sentence.slice(Math.max(0, m.index - 16), m.index))) continue;
        kinAt(m.groups.kw, sentence, m.index + m[0].length, indirect);
      }
      // "partner's away til thurs", "dad (Graham) is visiting": the bare word opening the
      // sentence, as its subject, is the user's own.
      const b = BARE_KIN.exec(sentence);
      if (b) kinAt(b.groups.kw, sentence, b.index + b[0].length, indirect);
    }
    }
    if (!assistant) {
      // Lowercase words used the way names are, for the store to confirm a lowercase name with.
      if (ls.includes("'s") || ls.includes(" and ") || ls.includes("(") || / (?:she|he)\b/.test(ls)) for (const re of NAMED) for (const m of sentence.matchAll(re)) {
        if (OTHERS_BEFORE.test(sentence.slice(Math.max(0, m.index - 16), m.index))) continue;
        const n = lowName(m.groups.n);
        if (n) add(`name:${n}`, "named", "lit:1", LOWER, "named");
      }
    }
    if (!assistant && HAS_NAME.test(sentence)) {
      for (const m of sentence.matchAll(R.myName)) { const n = cleanName(m.groups.n); if (n && !unsure(sentence, m.index)) add("me", "name", `lit:${n}`, explicit); }
      const im = R.imName.exec(sentence);
      if (im) { const n = cleanName(im.groups.n); if (n) add("me", "name", `lit:${n}`, CONF.indirect); }
    }
    if (hasCar) for (const m of sentence.matchAll(R.myCar)) if (!unsure(sentence, m.index)) car("me", "owns", m.groups, explicit);
    if (sentence.includes("editor")) for (const m of sentence.matchAll(R.myEditor)) { const t = toolOf(m.groups.t); if (t && !unsure(sentence, m.index)) add("me", "uses", t, explicit); }
    if (sentence.includes("client")) for (const m of sentence.matchAll(R.clientIs)) {
      const o = cleanRun(m.groups.o);
      if (o && !unsure(sentence, m.index)) add("me", "client", `org:${o}`, explicit);
    }
    if (HAS_COMPANY.test(sentence)) for (const m of sentence.matchAll(R.myCompany)) { const o = cleanRun(m.groups.o); if (o && !unsure(sentence, m.index)) add("me", "works_at", `org:${o}`, explicit); }
    if (/^(?:[Hh]ere\s+)?[Aa]t\s+[A-Z]/.test(sentence)) { const m = R.atOrgWe.exec(sentence); const o = m && cleanRun(m.groups.o); if (o) add("me", "works_at", `org:${o}`, indirect); }
    if (sentence.includes("client")) for (const m of sentence.matchAll(R.ourClient)) { const o = cleanRun(m.groups.o); if (o && !unsure(sentence, m.index)) add("me", "client", `org:${o}`, explicit); }

    // The verbs are matched in lower case: a sentence may start with one ("Sold the Outback").
    const low = sentence.charAt(0).toLowerCase() + sentence.slice(1);
    for (const p of R.preds) {
      if (p.car ? !hasCar : !p.hint.test(low)) continue;
      for (const m of low.matchAll(p.re)) {
        if (unsure(sentence, m.index)) continue;
        const tail = sentence.slice(Math.max(0, m.index - 100), m.index);
        const t = (p.tail === "poss" ? R.poss : R.subj).exec(tail);
        let s = null;
        if (t) {
          if (p.aux && !/(?:'m|'re|'s|\b(?:am|are|is|was|were)\b)/.test(t.groups.aux || "")) continue;
          s = subjectOf(t.groups, sentence, m.index, p.names);
        }
        // "Moved to Seattle last weekend", "Just bought a blue Volvo XC40": the user's own diary
        // style leaves out the I. Only at the very start of the sentence, and only in their words.
        if (!s && !assistant && p.tail === "subj" && !p.aux && ELLIPSIS.test(sentence.slice(0, m.index))) s = { ref: "me", conf: indirect };
        if (!s) continue;
        const conf = Math.min(s.conf, p.conf ?? explicit);
        const gr = m.groups;
        if (p.ob === "place") {
          const pl = gr.lpl ? lowPlace(gr.lpl) : cleanRun(gr.pl);
          if (pl) add(s.ref, p.rel, `place:${pl}`, conf, gr.lpl && conf <= LOWER ? "lower" : null);
        }
        else if (p.ob === "org") {
          const o = gr.lo !== undefined ? orgName(gr.lo) : cleanRun(gr.o);
          if (!o) continue;
          const r = p.role || (gr.r && !/\b(?:the|fan|client|customer|friend|member|guest|visitor|meeting|call|job|role|position|week|day|lot|bit)\b/i.test(gr.r) ? gr.r : null);
          if (gr.r && !r) continue;
          add(s.ref, p.rel, `org:${o}`, conf, conf <= LOWER ? "lower" : null);
          if (r) add(s.ref, "role", `lit:${lower(r)}`, conf);
        } else if (p.ob === "vehicle") {
          const v = car(s.ref, p.rel, gr, conf, !/^(?:have|has|got)\b/.test(m[0]));
          if (!v) continue;
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
      if (!vehicleOf(m.groups) || unsure(sentence, m.index)) continue;
      const the = /^[Tt]he$/.test(m.groups.det);
      const strong = CARISH.test(sentence.slice(m.index + m[0].length)) || !assistant && CAR_VERB.test(sentence.slice(0, m.index));
      if (the && !strong) continue;
      car("me", "owns", m.groups, indirect, strong);
    }
    if (!assistant) personalLower(sentence, ls, si);

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
