// @ts-check
// personal/answer: memory.answer (docs/work/memory-iq.md). A question about the user's own life
// in, one line out: "Your wife is Jordan.", "You drive a blue Volvo XC40.", with how sure and how
// many conversations said it.
//
// Three steps, the first that answers wins:
//   1. fact     the question is parsed by rules into a relation ("name of my wife" is the name of
//               kin:spouse) and read from personal facts, or from the graph for people outside
//               the user's life ("who is Dana Reyes").
//   2. meaning  the user's own first-person statements from recall.search (hybrid when Recall has
//               vectors), filtered the way the Capsule's said.js does. A said line is never more
//               than SAID_MAX sure.
//   3. keyword  the same over keyword search only, when meaning found nothing.
// A question that maps to a relation and has no fact gets no loose quote: only a sentence that
// states that relation ("my dentist is ...") may answer it. No model calls, ever.

import { KIN, relOfRole } from "./extract.js";

/** A said line (the user's own words, turned to "you") is worth at most this. */
export const SAID_MAX = 0.45;
/** Answer from here up; say "maybe" from MAYBE; say nothing under it. */
export const SURE = 0.5;
export const MAYBE = 0.3;
/** Sources given without asking: cheap, and enough to show where it came from. */
const SOURCES = 3;
const SOURCES_ASKED = 10;
/** The graph's facts are about other people; they never read as more certain than this. */
const GRAPH_MAX = 0.9;

// ------------------------------------------------------------------ the question

/** Question and filler words: never a name, never a key noun. */
const STOP = new Set(`a an the i i'm me my mine myself we our us you your is are was were am be been do does did have has had what whats
  what's which who whom whose where when why how of to for in on at by with and or not no it its this that there here
  name named called call tell know remind please again now currently still ever any some one about like go goes going
  get got see other half`.split(/\s+/));

/** Words the rules read. A typo within one edit of one of these is read as it ("wfie" is "wife"). Short
 * common words ("name", "live") are left out: one edit turns too many ordinary words into them. */
// "mama" is one letter from Maya, Mara and Mika: names win.
const VOCAB = new Set([...Object.keys(KIN).filter(w => w !== "mama" && w !== "ma"), "birthday", "bday", "vehicle", "drive", "company", "employer", "client", "clients", "contact",
  "editor", "prefer", "colour", "before", "where", "which"]);

/** Damerau-Levenshtein distance, stopping early past 1: all a typo check needs. */
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  if (a.length === b.length) {
    const d = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
    if (d.length === 1) return true;
    return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** One word, typos read as the word meant; possessives and plural typos folded ("wifes" -> "wife"). */
function fixWord(w) {
  if (!w || VOCAB.has(w) || STOP.has(w)) return w;
  if (w.endsWith("s") && KIN[w.slice(0, -1)]) return w.slice(0, -1);
  if (w.length < 4) return w;
  for (const v of VOCAB) if (v.length >= 4 && near(w, v)) return v;
  if (w.endsWith("s")) { const b = w.slice(0, -1); for (const v of Object.keys(KIN)) if (v.length >= 4 && near(b, v)) return v; }
  return w;
}

/**
 * The question in a canonical shape: lower case, contractions opened, possessives dropped,
 * typos fixed. "whats my wfie's name" -> "what is my wife name".
 * @param {string} q
 */
export function normalize(q) {
  let t = String(q || "").replace(/[‘’ʼ`´]/g, "'").toLowerCase();
  t = t.replace(/\b(who|what|where|when|how|it|that)'s\b/g, "$1 is").replace(/\bwhats\b/g, "what is").replace(/\b(?:wat|wht|waht)\b/g, "what")
    .replace(/\bi'm\b/g, "i am").replace(/\bb-day\b/g, "bday").replace(/\bfavorite\b/g, "favourite")
    // The other parent is the spouse: "the kids' mum", "my son's dad". "the mrs", "the missus", married to.
    .replace(/\b(?:the|my|our) (?:kids?|children|son|daughter|boys?|girls?)(?:'s|s'|')? (?:mum|mom|mother|dad|father|mama|papa)\b/g, "my spouse")
    .replace(/\b(?:the|my) (?:mrs|missus|misses|old lady|old man|better half)\b/g, "my spouse").replace(/\bother halfs\b/g, "other half")
    .replace(/^who am i married to\b|^who(?: am i| is)? (?:i'm |i am )?married to\b|^who did i marry\b/, "who is my spouse");
  t = t.replace(/[?!.,;:()"]+/g, " ").replace(/'s\b|s'(?=\s|$)/g, m => (m === "s'" ? "s" : "")).replace(/'/g, "");
  return t.split(/\s+/).filter(Boolean).map(fixWord).join(" ");
}

const KINW = Object.keys(KIN).sort((a, b) => b.length - a.length).join("|");
const KIN_RE = new RegExp(`\\b(${KINW})\\b`);
/** Friend words, read here whether or not extract.js's KIN has them yet. "mate" only as "my mate". */
const FRIEND = /** @type {Record<string, string>} */ ({ "best friend": "friend", "best friends": "friend", friend: "friend", friends: "friend", buddy: "friend",
  buddies: "friend", pal: "friend", pals: "friend", bestie: "friend", besties: "friend", mate: "friend", mates: "friend" });
const FRIEND_RE = /\b(best friends?|besties?|friends?|buddy|buddies|pals?)\b|\bmy (mates?)\b/;
/** The role a kin or friend word names ("wife": spouse, "buddy": friend), or null. */
const roleOf = w => KIN[w]?.[0] || FRIEND[w] || null;
/** Plural words for one of them: "your friends are Theo and Ana", "your friend is Theo". */
const ONE = /** @type {Record<string, string>} */ ({ pets: "pet", friends: "friend", "best friends": "best friend", buddies: "buddy", pals: "pal", besties: "bestie", mates: "mate" });
/** Words for a vehicle: "what truck did I buy" asks about the user's car. */
const CAR_RE = /\b(?:car|cars|vehicle|drive|driving|ride|truck|trucks|pickup|van|suv|motorbike|motorcycle|bike)\b/;
/** Diets a yes/no question can name. */
const DIETS = "vegetarian|vegan|pescatarian|pescetarian|halal|kosher|keto|paleo|gluten free|gluten-free|dairy free|dairy-free|plant based|plant-based|flexitarian|carnivore";
/** Someone asked about by word or name: "my wife", "mom", "dani", "biscuit". */
const SUBJ = "((?:my|our) [a-z]+(?: [a-z]+)?|[a-z][a-z'-]*(?: [a-z][a-z'-]*)?)";
/** Question shapes about someone else's attribute. S is the someone. Anchored: a longer question is not this one. */
const OF = /** @type {[RegExp, string][]} */ ([
  ["what (?:does|did) S do(?: (?:for (?:work|a living|money|a job)|now|these days|nowadays|professionally))?", "role"],
  ["what (?:is|was) S (?:job|occupation|profession|line of work|job title|work)", "role"],
  ["S (?:job|occupation|profession)", "role"],
  ["what does S work as", "role"],
  ["(?:where|who) does S work(?: for| at| now)?", "works_at"],
  ["(?:what|which) (?:company|firm|place) does S work (?:for|at)", "works_at"],
  ["where is S working(?: now)?", "works_at"],
  ["where does S live(?: now| these days)?", "lives_in"],
  ["where (?:is|are) S (?:living|based)(?: now)?", "lives_in"],
  ["(?:what|which) (?:city|town|country|state) does S live in", "lives_in"],
  ["where did S move(?: to)?", "lives_in"],
  ["where (?:is|was) S (?:from|born)", "from"],
  ["where does S come from", "from"],
  ["what (?:breed|kind|type|sort)(?: of (?:dog|cat|pet))? is S", "breed"],
  ["what (?:is )?S breed", "breed"],
  ["what colou?r is S", "color"],
  [`is S (?:an? )?(?:${DIETS})`, "diet"],
  ["what (?:is )?S diet", "diet"],
  ["what (?:car |truck |van |vehicle )?does S (?:drive|have|own)(?: now)?", "car"],
  ["what (?:car|truck|van|vehicle) (?:is|was) S driving", "car"],
  ["how old (?:is|are) S(?: now)?", "age"],
  ["what age is S(?: now)?", "age"],
  ["(?:what (?:is|are) )?S (?:hobby|hobbies)", "hobby"],
  ["what does S do for fun", "hobby"],
].map(([s, rel]) => [new RegExp(`^${s.replace("S", SUBJ)}$`), rel]));
const PRONOUN = new Set("he she they him her them his hers theirs someone anyone everyone somebody nobody".split(" "));

/** Who an OF question is about: a relative's word, or a name. null: nobody the user could mean. */
function subjOf(x) {
  const m = /^(?:my|our) (.+)$/.exec(x);
  if (m) return roleOf(m[1]) ? { kin: m[1] } : null;
  if (roleOf(x) && x !== "mate" && x !== "mates") return { kin: x };
  const ws = x.split(" ");
  if (ws.some(w => STOP.has(w) || PRONOUN.has(w) || roleOf(w))) return null;
  return { name: x };
}

/** A question about someone else's attribute ("what does my wife do", "where does dani work"), or null. */
function ofQuestion(t) {
  for (const [re, rel] of OF) {
    const m = re.exec(t);
    const who = m && subjOf(m[1]);
    if (who) return { kind: /** @type {const} */ ("of"), who, rel };
  }
  // "what kind of dog do we have" is the breed of the user's dog.
  const m = /^what (?:breed|kind|type|sort) of (dog|cat|puppy|kitten) do (?:i|we) have$/.exec(t);
  return m ? { kind: /** @type {const} */ ("of"), who: { kin: m[1] }, rel: "breed" } : null;
}

/** Makes asked about by name: "do i drive a tesla". */
const MAKE_Q = /\b(tesla|toyota|honda|ford|chevy|chevrolet|volvo|bmw|audi|subaru|mazda|nissan|hyundai|kia|volkswagen|vw|jeep|lexus|porsche|rivian|polestar|mercedes|mini|fiat|dodge|gmc|ram)\b/;
/** Body types of common models, so "what truck did i buy" is the Maverick and "do i own a van" is not. */
const BODY = /** @type {Record<string, string[]>} */ ({
  truck: ["maverick", "f-150", "f150", "ranger", "tacoma", "tundra", "silverado", "sierra", "ram", "frontier", "titan", "gladiator", "r1t", "cybertruck", "ridgeline", "colorado", "canyon"],
  van: ["transit", "sprinter", "sienna", "odyssey", "carnival", "pacifica", "promaster", "id buzz", "vito", "caddy"],
  suv: ["outback", "forester", "crosstrek", "rav4", "cr-v", "cx-5", "xc40", "xc60", "xc90", "model y", "model x", "r1s", "4runner", "highlander", "explorer", "tahoe", "equinox", "tiguan", "sportage", "sorento", "telluride", "kona", "tucson", "outlander", "wrangler", "cherokee", "defender", "bronco", "pilot", "rogue", "ioniq 5", "ev6", "niro", "macan", "cayenne", "expedition", "mach-e"],
});
BODY.pickup = BODY.truck; BODY.minivan = BODY.van;
/** Is this vehicle of the type asked ("Ford Maverick" is a truck)? Unknown models are not. */
const isType = (label, q) => (BODY[q] || []).some(m => hasWord(String(label).toLowerCase(), m)) || (["bike", "motorbike", "motorcycle"].includes(q) && /\b(?:harley|ducati|yamaha|kawasaki|triumph|ktm|vespa)\b/i.test(label));

/** Nouns whose members people name without the noun: "what editor do I use" is answered by "Neovim". */
const CATEGORY = /** @type {Record<string, string[]>} */ ({
  editor: ["vim", "neovim", "nvim", "emacs", "vs code", "vscode", "visual studio code", "sublime", "zed", "helix", "intellij", "webstorm", "cursor", "nano", "xcode", "pycharm"],
  "text editor": ["vim", "neovim", "nvim", "emacs", "vs code", "vscode", "sublime", "zed", "helix", "nano"],
  ide: ["vs code", "vscode", "intellij", "webstorm", "pycharm", "xcode", "cursor", "android studio"],
  terminal: ["iterm", "iterm2", "alacritty", "kitty", "wezterm", "ghostty", "warp", "terminal"],
  shell: ["zsh", "bash", "fish", "nushell"],
  browser: ["chrome", "firefox", "safari", "arc", "brave", "edge"],
  phone: ["iphone", "pixel", "galaxy", "android", "oneplus"],
  laptop: ["macbook", "thinkpad", "xps", "surface"],
  drink: ["tea", "coffee", "water", "juice", "beer", "wine"],
  "design tool": ["figma", "sketch", "adobe xd", "xd", "photoshop", "illustrator", "indesign", "canva", "affinity", "framer", "penpot", "procreate"],
  notes: ["obsidian", "notion", "evernote", "bear", "logseq", "roam", "onenote", "apple notes", "joplin", "craft", "notability", "goodnotes"],
});
CATEGORY["api client"] = ["bruno", "postman", "insomnia", "hoppscotch", "httpie", "paw", "rapidapi", "thunder client"];
CATEGORY["api tool"] = CATEGORY["api client"];
CATEGORY["design app"] = CATEGORY["design tool"];
CATEGORY.design = CATEGORY["design tool"];
CATEGORY.note = CATEGORY.notes;
CATEGORY["note app"] = CATEGORY.notes;
CATEGORY["notes app"] = CATEGORY.notes;
Object.assign(CATEGORY, {
  "db gui": ["tableplus", "dbeaver", "datagrip", "pgadmin", "sequel ace", "sequel pro", "postico", "beekeeper", "beekeeper studio", "heidisql", "navicat", "mysql workbench"],
  "terminal multiplexer": ["tmux", "zellij", "screen", "byobu"],
  "password manager": ["1password", "bitwarden", "lastpass", "dashlane", "keepass", "keepassxc", "proton pass", "nordpass", "enpass", "apple passwords", "keychain"],
  calendar: ["google calendar", "fantastical", "outlook", "apple calendar", "busycal", "notion calendar", "calendar"],
  "email client": ["superhuman", "spark", "thunderbird", "outlook", "apple mail", "mimestream", "airmail", "gmail", "mailmate", "proton mail"],
});
for (const a of ["database gui", "database client", "db client", "sql client", "database tool", "db tool"]) CATEGORY[a] = CATEGORY["db gui"];
for (const a of ["multiplexer", "tmux alternative"]) CATEGORY[a] = CATEGORY["terminal multiplexer"];
for (const a of ["passwords", "password app", "password tool"]) CATEGORY[a] = CATEGORY["password manager"];
for (const a of ["calendar app", "calendar tool"]) CATEGORY[a] = CATEGORY.calendar;
for (const a of ["email", "mail", "email app", "mail app", "mail client"]) CATEGORY[a] = CATEGORY["email client"];

/**
 * @typedef {{ kind: "kin", word: string, role: string, count?: boolean }
 *   | { kind: "birthday", who: Who }
 *   | { kind: "born" }
 *   | { kind: "car", before: string|null, color: boolean, qual?: string|null }
 *   | { kind: "lives", before: string|null }
 *   | { kind: "work", before?: boolean }
 *   | { kind: "job" }
 *   | { kind: "clients" }
 *   | { kind: "contact", org: string }
 *   | { kind: "uses", cat: string|null }
 *   | { kind: "prefers", options: string[], cat: string|null }
 *   | { kind: "owns", cat: string }
 *   | { kind: "myname" }
 *   | { kind: "who", name: string }
 *   | { kind: "attr", noun: string }
 *   | { kind: "of", who: { kin?: string, name?: string, me?: boolean }, rel: string, cat?: string|null }
 *   | { kind: "carFate", car: string }
 *   | { kind: "diet", asked: string|null }} Parsed
 * @typedef {{ kin?: string, name?: string, me?: boolean }} Who
 */

/** A noun phrase with filler and leading articles taken off. */
const content = s => String(s || "").split(/\s+/).filter(w => w && !STOP.has(w)).join(" ");

/**
 * What a question asks, by rules. null: no rule knows it, so only meaning and keywords can answer.
 * @param {string} q
 * @returns {Parsed|null}
 */
export function parse(q) {
  const t = normalize(q);
  if (!t) return null;
  const kin = KIN_RE.exec(t)?.[1] || (m0 => m0 && (m0[1] || m0[2]))(FRIEND_RE.exec(t)) || null;
  const role = kin ? roleOf(kin) : null;
  let m;

  // Someone at an organisation: "who is my contact at Harlow Legal".
  if ((m = /\b(?:contact|person|people|who works?|who do i (?:deal|work|talk) with)\s+(?:at|from|in)\s+(.+)$/.exec(t))) return { kind: "contact", org: m[1].trim() };
  // A "db client" or "email client" is software, not a customer.
  if (/\bclients?\b/.test(t) && !kin && !/\b(?:db|database|sql|email|mail|git|ftp|api|http|rest) clients?\b/.test(t)) return { kind: "clients" };
  if (/\b(?:birthday|bday)\b/.test(t) || /\bwhen (?:is|was) .*\bborn\b/.test(t)) return { kind: "birthday", who: whoOf(t, kin) };
  if (!kin && /^(?:what (?:are|is) my (?:hobby|hobbies)|my (?:hobby|hobbies)|what do i do for fun|what do i (?:like|love|enjoy) doing|what do i do in my (?:free|spare) time)$/.test(t)) return { kind: "of", who: { me: true }, rel: "hobby" };
  // Someone else's relative: "whats rhodri's wife called" (normalized "rhodri wife") is not the user's wife.
  if ((m = new RegExp(`(?:^|\\s)([a-z][a-z-]+) (${KINW})\\b`).exec(t)) && !STOP.has(m[1]) && !roleOf(m[1]) && !/^(?:my|our|the|a|an|your|his|her|their|old|new|little|big|baby|younger|older|eldest|youngest|first|second|best|other|kids|same)$/.test(m[1])) {
    const r2 = roleOf(m[2]);
    if (r2 && r2 !== "friend") return { kind: "of", who: { name: m[1] }, rel: `kin:${m[2]}` };
  }
  // Someone else's attribute before any of the user's own: "where does my mom live" is not where the user lives.
  const of = ofQuestion(t);
  if (of) return of;
  if (/\bwhere (?:was|were|am|are) (?:i|you) (?:born|from)\b|\bwhere do i come from\b|\bhome ?town\b|\bborn\b/.test(t)) return { kind: "born" };
  if (!kin) {
    if ((m = new RegExp(`\\b(?:am i|are we)(?: an?)? (${DIETS})\\b|\\bdo (?:i|we) (?:eat|keep|follow|go) (${DIETS})\\b`).exec(t))) return { kind: "diet", asked: m[1] || m[2] };
    if (/\bdiet\b/.test(t) && /\b(?:i|my|me|we|our)\b/.test(t) || /\bdo (?:i|we) eat (?:meat|fish|pork|beef|chicken|dairy|eggs|seafood|animal products)\b/.test(t)) return { kind: "diet", asked: null };
  }
  const before = (m = /\bbefore (?:the |my |i |we )*(.+)$/.exec(t)) ? content(m[1]) || "then" : /\b(?:previous|previously|used to|old|first|last)\b|\bbefore$/.test(t) ? "then" : null;
  // A relative's car is theirs: "what does my wife drive". Its colour or history is not read here.
  if (kin && role !== "dog" && role !== "cat" && CAR_RE.test(t)) return { kind: "of", who: { kin }, rel: before || /\bcolou?r\b/.test(t) ? "car:detail" : "car" };
  // Something a relative does that no rule reads ("what does my wife do for fun"): not their name.
  if (kin && /^(?:what|where|when|how|why) (?:does|did) (?:my|our) /.test(t)) return { kind: "of", who: { kin }, rel: "other" };
  if (kin && (m = /\b(?:favou?rite|prefers?)\b(.*)$/.exec(t))) return { kind: "of", who: { kin }, rel: "prefers", cat: content(m[1].replace(new RegExp(`\\b${esc(kin)}\\b`), " ")) || null };
  // The fate of one vehicle: "what happened to the outback", "do i still have the subaru".
  if (!kin && ((m = /^what happened (?:to|with) (?:the |my |our |that |old )*(.+)$/.exec(t))
    || (m = /^(?:do|did|have) (?:i|we) still (?:have|own|drive|got) (?:the |my |our |that |a |an )*(.+?)(?: now| anymore| any more)?$/.exec(t))
    || (m = /^(?:do|did) (?:i|we) (?:sell|get rid of|trade in|scrap) (?:the |my |our |that |old )*(.+)$/.exec(t))
    || (m = /^is (?:the |my |our )(.+?) (?:gone|sold|still mine|still ours)$/.exec(t)))) {
    const car = content(m[1]);
    if (car) return { kind: "carFate", car };
  }
  // A move is a place lived: "where did we move to" is now, "where did we move from" before.
  if ((m = /^(?:where|which (?:city|town|country|place)) did (?:i|we) (?:move|relocate)(?: to)?( from)?(?: again)?$/.exec(t))) return { kind: "lives", before: m[1] ? "then" : null };
  // "what electric car do i drive": a kind of car memory cannot check is asked of the car's own words.
  if (CAR_RE.test(t)) {
    const qual = before ? null : /\b(electric|ev|hybrid|diesel|petrol|gas|sports?|convertible|classic|vintage|work)\b/.exec(t)?.[1]
      || /\b(van|suv|motorbike|motorcycle|bike|truck|pickup|minivan)\b/.exec(t)?.[1] || MAKE_Q.exec(t)?.[1];
    return { kind: "car", before, color: /\bcolou?r\b/.test(t), ...(qual ? { qual } : {}) };
  }
  // A job question before a place: "what do i do for a living" is not where the user lives.
  if (/\bwhat do i do\b(?! for (?:fun|lunch|dinner))|\bfor a living\b|\bwhat (?:is|was) my (?:job|role|occupation|profession|line of work|job title)\b|\bmy (?:job|occupation|profession|line of work)$|\bwhat do i work as\b|\bwork do i do\b/.test(t)) return { kind: "job" };
  if (/\b(?:live|lived|living|based|reside)\b/.test(t) && /\b(?:i|we|my)\b/.test(t)) return { kind: "lives", before };
  if (/\b(?:which|what) (?:city|town|place|country)\b.*\b(?:am i|are we|do i|do we)\b|\bwhere am i\b/.test(t)) return { kind: "lives", before };
  if (/\bwhere (?:did i used to|did i use to|used i to|did i) work\b(?! now)|\b(?:old|previous|last|former) (?:job|company|employer|work)\b|\bwho did i (?:use to |used to )?work for\b/.test(t) && !/\bwhere do i work\b/.test(t)) return { kind: "work", before: true };
  if (/\bwhere (?:do|did) i work\b|\bwho do i work for\b|\bmy (?:company|employer|studio|business|firm|agency|job|workplace|llc|ltd|inc)\b|\bcompany\b.*\b(?:i|my)\b|\bname of my (?:company|business|firm|studio|llc)\b/.test(t)) return { kind: "work" };
  if ((m = /\b(?:what|which) (?:app|tool|program|software|thing|service)s? do i (?:keep|take|write|store|put|track|do) (?:all |most )?(?:of )?my ([a-z]+)/.exec(t))) return { kind: "uses", cat: m[1] };
  if ((m = /\b(?:what|which) (.+?) do i use\b/.exec(t)) || (m = /\bwhat do i use for (.+)$/.exec(t))) return { kind: "uses", cat: content(m[1]) || null };
  if (/\bwhat do i use\b/.test(t)) return { kind: "uses", cat: null };
  if (/\bprefer\b/.test(t)) {
    const opts = (m = /\bprefer (.+?) or (.+)$/.exec(t)) ? [content(m[1]), content(m[2])].filter(Boolean) : [];
    return { kind: "prefers", options: opts, cat: opts.length ? null : content(t.replace(/^.*\bprefer\b/, "")) || null };
  }
  if ((m = /\bfavou?rite (.+)$/.exec(t))) return { kind: "prefers", options: [], cat: content(m[1]) || null };
  if ((m = /\b(?:what|which) (.+?) do i (?:have|own|go to|use|drink|eat)\b/.exec(t))) return { kind: kin ? "kin" : "owns", ...(kin ? { word: kin, role } : { cat: content(m[1]) }) };
  if (!kin && (/\bwhat is my name\b|\bwho am i\b|^my name$|\bmy (?:own |full )?name\b/.test(t))) return { kind: "myname" };
  // "what pets do we have": every pet, dogs and cats alike.
  if (!kin && (m = /\b(pets)\b|\bhow many (pets)\b|\bour (pet)s?\b/.exec(t)) && !/\b(?:name|called)\b.*\b(?:dog|cat)\b/.test(t)) return { kind: "kin", word: "pets", role: "pet", ...(/^how many\b/.test(t) ? { count: true } : {}) };
  // "how many kids do i have": the count, then the names.
  if (kin && role && /^how many\b/.test(t)) return { kind: "kin", word: kin, role, count: true };
  // Something of theirs that is not their name ("the kids school", "my wife's car"): not their names.
  if (kin && role && (m = new RegExp(`\\b${esc(kin)} ([a-z]+)`).exec(t)) && !/^(?:name|names|called|is|are|was|were|do|does|did|have|has|and|or|i|we)$/.test(m[1]) && !STOP.has(m[1])) return { kind: "of", who: { kin }, rel: "other" };
  if (kin && role) return { kind: "kin", word: kin, role };
  if ((m = /^(?:who|what) (?:is|was|are) (.+)$/.exec(t)) || (m = /^(?:do you know|tell me about) (.+)$/.exec(t))) {
    const x = m[1].trim();
    if (/^(?:my|our) /.test(x)) return { kind: "attr", noun: content(x) };
    if (content(x)) return { kind: "who", name: x.replace(/^(?:the|a|an) /, "") };
  }
  if ((m = /\b(?:my|our) ([a-z][a-z ]*)$/.exec(t))) return { kind: "attr", noun: content(m[1]) };
  return null;
}

/** Whose birthday: a relative's, a name's, or the user's own. */
function whoOf(t, kin) {
  if (kin) return { kin };
  const rest = t.replace(/\b(?:birthday|bday|born|when|is|was|what|the|date|of|day)\b/g, " ");
  const name = content(rest.replace(/\b(?:my|i)\b/g, " "));
  if (name) return { name };
  return { me: true };
}

// ------------------------------------------------------------------ the answer

/**
 * @typedef {import("./store.js").Fact} Fact
 * @typedef {{ answer: string|null, confidence: number|null, kind: "fact"|"said"|null, from: number, facts: any[],
 *   sources: { session: string, seq: number, name: string|null, quote: string, ts: number|null }[], via: "fact"|"meaning"|"keyword"|null, ms: number }} Answer
 */

const round = x => Math.round(x * 1000) / 1000;
const list = xs => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const ROLE_WORD = /** @type {Record<string, string>} */ ({ spouse: "spouse", partner: "partner", mother: "mother", father: "father", child: "child", son: "son", daughter: "daughter", brother: "brother", sister: "sister", pet: "pet", friend: "friend", colleague: "colleague" });
const PEOPLE = new Set(Object.keys(ROLE_WORD));
/** Pet names for relatives, in their plain form. */
const FORMAL = /** @type {Record<string, string>} */ ({ hubby: "husband", wifey: "wife", missus: "wife", mummy: "mum", mommy: "mom", ma: "mom", mama: "mom", daddy: "dad" });
const KIN_LABEL = new Set([...Object.keys(KIN), ...Object.keys(ROLE_WORD)]);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${esc(w)}($|[^a-z0-9])`, "i").test(text);

/**
 * The answerer over one store. Returns answer(input) -> Answer.
 * @param {{ personal: import("./store.js").Personal, graph?: any, db: import("node:sqlite").DatabaseSync,
 *   me?: { name?: string }|null, call?: (tool: string, input: any) => Promise<{ data?: any, error?: any }>, scratch?: string|null }} deps
 */
export function answerer({ personal, graph = null, db, me = null, call = null, scratch = null }) {
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
  const turnQ = () => hasTable("recall_turns") ? db.prepare("SELECT text, role, ts FROM recall_turns WHERE session = ? AND seq = ?") : null;
  const sessQ = () => hasTable("recall_sessions") ? db.prepare("SELECT name, title FROM recall_sessions WHERE id = ?") : null;

  /** The sentence of a turn that names what the answer says, else its start. */
  const quoteOf = (text, keys) => {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    const sentences = s.split(/(?<=[.!?])\s+/);
    const hit = sentences.find(x => keys.some(k => k && hasWord(x, k))) || sentences[0] || "";
    return hit.length > 200 ? hit.slice(0, 199).replace(/\s+\S*$/, "") + "..." : hit;
  };
  /** Where facts came from: their evidence turns, with a quote each. */
  const sourcesOf = (facts, n) => {
    const tq = turnQ(), sq = sessQ();
    const out = [], seen = new Set();
    for (const f of facts) {
      const keys = [f.object, f.subject].filter(x => x && !KIN_LABEL.has(String(x).toLowerCase()));
      for (const e of personal.evidence(f.id, n)) {
        const k = `${e.session}\u0000${e.seq}`;
        if (seen.has(k) || out.length >= n) continue;
        if (e.session.startsWith("told:")) {
          // Told to memory outright: the line itself is the source.
          const told = personal.told(e.session.slice(5));
          if (!told) continue;
          seen.add(k);
          out.push({ session: e.session, seq: e.seq, name: "told to memory", quote: quoteOf(told.text, keys), ts: told.ts });
          continue;
        }
        if (!tq) continue;
        const t = /** @type {any} */ (tq.get(e.session, e.seq));
        if (!t) continue;
        seen.add(k);
        const s = /** @type {any} */ (sq?.get(e.session));
        out.push({ session: e.session, seq: e.seq, name: s ? String(s.name || s.title || "") || null : null, quote: quoteOf(t.text, keys), ts: e.ts ?? (Number(t.ts) || null) });
      }
    }
    return out;
  };
  const factOut = f => ({ id: f.id, subject: f.subject, rel: f.rel, object: f.object, confidence: f.confidence, sessions: f.sessions, first_seen: f.first_seen, last_seen: f.last_seen });

  /**
   * One answer from facts: the line, facts behind it, how sure (the weakest fact), where from.
   * @param {string} line @param {Fact[]} facts @param {{ conf?: number }} [o]
   */
  const fromFacts = (line, facts, o = {}) => ({ line, facts, conf: o.conf ?? Math.min(...facts.map(f => f.confidence)) });

  const current = fs => fs.filter(f => f.current);
  /** The word for a relative, in its plain form: "hubby" reads as "husband". */
  const kinWord = (id, fallback) => { const w = personal.called(id); return w ? FORMAL[w] || w : fallback; };
  /** The genders the words for someone carry ("husband", "hubby": m). Empty when none say. */
  const gendersOf = id => new Set((personal.about(id)?.aliases || []).map(a => KIN[a.replace(/^my /, "")]?.[1]).filter(Boolean));
  /** Is an entity label just a kin word (the relative was never named)? */
  const unnamed = label => KIN_LABEL.has(String(label).toLowerCase());

  /** A vehicle with its colour when known: "a blue Volvo XC40". */
  const carText = (f, article = true) => {
    const col = current(personal.lookup({ subj: f.obj, rel: "color" }))[0];
    const name = (col ? col.object + " " : "") + f.object;
    return { text: article ? (/^[aeiou]/i.test(name) ? "an " : "a ") + name : name, col };
  };

  /**
   * The relatives the user calls by a word: their current links from me, once each, of the gender
   * and species asked. No partner said: the spouse is one, and back, unless that partner is only
   * ever a girlfriend, boyfriend or fiance (not a spouse).
   * @param {string} word @param {string} role
   */
  const relatives = (word, role) => {
    const asked = KIN[word]?.[1] || null;
    const pick = rel => current(rel === "child" ? ["child", "son", "daughter"].flatMap(r => personal.lookup({ subj: "me", rel: r })) : personal.lookup({ subj: "me", rel }))
      .filter((f, i, a) => a.findIndex(x => x.obj === f.obj) === i)
      // "my wife" is never the one only ever called "husband".
      .filter(r => { if (!asked) return true; const gs = gendersOf(r.obj); return !gs.size || gs.has(asked); })
      // A pet is the one of the species asked about: a dog is never the answer about a cat.
      .filter(r => rel !== "pet" || role === "pet" || r.obj === `kin:${role}` || KIN[personal.called(r.obj) || ""]?.[0] === role);
    const rel = relOfRole(role);
    const rs = pick(rel);
    if (rs.length || (rel !== "spouse" && rel !== "partner")) return rs;
    const other = pick(rel === "spouse" ? "partner" : "spouse");
    if (rel === "partner") return other;
    return other.filter(r => !(personal.about(r.obj)?.aliases || []).some(a => /^(?:my )?(?:girlfriend|boyfriend|fiancee?|fiancée?)$/.test(a)));
  };

  /**
   * The one person or pet an `of` question is about, and how to name them in the answer.
   * null: nobody, several (two sisters: which one?), or the user themselves.
   * @param {{ kin?: string, name?: string }} who
   */
  const subjectOf = who => {
    if (who.me) return { id: "me", label: "You" };
    if (who.kin) {
      const word = who.kin, role = roleOf(word);
      if (!role) return null;
      const rs = relatives(word, role);
      if (rs.length > 1) return null;
      let id = rs[0]?.obj || null;
      if (!id) {
        const e = personal.entity(`my ${word}`) || personal.entity(`kin:${role}`);
        if (!e || e.id === "me" || (e.kind !== "person" && e.kind !== "pet")) return null;
        const asked = KIN[word]?.[1], gs = gendersOf(e.id);
        if (asked && gs.size && !gs.has(asked)) return null;
        if ((role === "dog" || role === "cat") && e.id !== `kin:${role}` && KIN[personal.called(e.id) || ""]?.[0] !== role) return null;
        id = e.id;
      }
      // A pet goes by its name ("Biscuit is a beagle"); a person by the word asked ("Your wife").
      const nm = current(personal.lookup({ subj: id, rel: "name" }))[0];
      const pet = role === "dog" || role === "cat";
      return { id, label: pet && nm ? cap(nm.object) : `Your ${FORMAL[word] || ONE[word] || word}`, nm };
    }
    let e = personal.entity(String(who.name));
    if (!e && /\s/.test(String(who.name))) { const f0 = personal.entity(String(who.name).split(/\s+/)[0]); if (f0 && f0.kind === "person" && !/\s/.test(f0.label)) e = f0; }
    if (!e || e.id === "me" || (e.kind !== "person" && e.kind !== "pet")) return null;
    const nm = current(personal.lookup({ subj: e.id, rel: "name" }))[0];
    const label = nm ? nm.object : e.label;
    return { id: e.id, label: unnamed(label) ? `Your ${label}` : cap(label), nm };
  };
  const art = x => (/^(?:a|an|the|my|his|her|their)\s/i.test(x) ? x : (/^[aeiou]/i.test(x) ? "an " : "a ") + x);

  /** Personal facts for a parsed question. null: no fact answers it. */
  const byFact = (/** @type {Parsed} */ p) => {
    switch (p.kind) {
      case "kin": {
        const named = [];
        for (const r of relatives(p.word, p.role)) {
          if (unnamed(r.object)) continue;
          const nm = current(personal.lookup({ subj: r.obj, rel: "name" }))[0];
          named.push({ r, nm, label: nm ? nm.object : r.object });
        }
        if (!named.length) return null;
        const facts = named.flatMap(x => (x.nm ? [x.r, x.nm] : [x.r]));
        const conf = Math.min(...named.map(x => Math.min(x.r.confidence, x.nm ? x.nm.confidence : x.r.confidence)));
        const one = ONE[p.word] || p.word;
        const word = p.word === "kids" || p.word === "children" ? p.word : named.length > 1 ? pluralOf(one) : one;
        const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
        const line = p.count ? `You have ${NUM[named.length] ?? named.length} ${named.length === 1 ? p.word.replace(/s$/, "").replace(/^children$/, "child") : pluralOf(p.word.replace(/s$/, ""))}: ${list(named.map(x => x.label))}.`
          : `Your ${word} ${named.length > 1 ? "are" : "is"} ${list(named.map(x => x.label))}.`;
        return { line, facts, conf, sessions: Math.max(...named.map(x => (x.nm || x.r).sessions)) };
      }
      case "birthday": {
        const e = p.who.me ? personal.entity("me") : p.who.kin ? personal.entity(`my ${p.who.kin}`) || personal.entity(`kin:${roleOf(p.who.kin)}`) : personal.entity(String(p.who.name));
        if (!e) return null;
        const f = current(personal.lookup({ subj: e.id, rel: "birthday" }))[0];
        if (!f) return null;
        return fromFacts(e.id === "me" ? `Your birthday is ${f.object}.` : `${unnamed(e.label) ? "Your " + e.label + "'s" : e.label + "'s"} birthday is ${f.object}.`, [f]);
      }
      case "born": {
        const f = current(personal.lookup({ subj: "me", rel: "from" }))[0];
        return f ? fromFacts(`You are from ${f.object}.`, [f]) : null;
      }
      case "car": {
        const owns = personal.lookup({ subj: "me", rel: "owns" }).filter(f => f.obj.startsWith("vehicle:"));
        const drives = personal.lookup({ subj: "me", rel: "drives" });
        if (p.before) {
          const now = current(owns).concat(current(drives));
          const was = owns.filter(f => !f.current && !now.some(n => n.obj === f.obj)).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
          if (!was.length) return null;
          const f = was[0];
          const then = now[0] ? `Before the ${now[0].object} you had` : "You used to have";
          return fromFacts(`${then} ${carText(f).text}.`, [f, ...now.slice(0, 1)], { conf: f.confidence });
        }
        const d = current(drives)[0];
        const cur = current(owns);
        const f = d && cur.some(o => o.obj === d.obj) ? cur.find(o => o.obj === d.obj) : cur[0] || d;
        if (!f) return null;
        if (p.qual && !hasWord(f.object, p.qual) && !isType(f.object, p.qual)) return null;
        const c = carText(f);
        if (p.color) {
          if (!c.col) return null;
          return fromFacts(`Your ${f.object} is ${c.col.object}.`, [c.col, f], { conf: Math.min(c.col.confidence, f.confidence) });
        }
        const verb = d && d.obj === f.obj ? "drive" : "own";
        return fromFacts(`You ${verb} ${c.text}.`, [f, ...(c.col ? [c.col] : [])], { conf: f.confidence });
      }
      case "lives": {
        const all = personal.lookup({ subj: "me", rel: "lives_in" });
        const now = current(all)[0];
        if (p.before) {
          const was = all.filter(f => !f.current).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
          if (!was) return null;
          // A lower share is expected for a place left behind: it is known, only no longer true.
          return fromFacts(`${now ? `Before ${now.object} you lived` : "You used to live"} in ${was.object}.`, [was, ...(now ? [now] : [])],
            { conf: Math.max(was.confidence, now ? Math.min(0.9, now.confidence) : 0) });
        }
        return now ? fromFacts(`You live in ${now.object}.`, [now]) : null;
      }
      case "work": {
        const all = personal.lookup({ subj: "me", rel: "works_at" });
        const now = current(all)[0];
        if (p.before) {
          const was = all.filter(f => !f.current && f.obj !== now?.obj).sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))[0];
          return was ? fromFacts(`${now ? `Before ${now.object} you worked` : "You used to work"} at ${was.object}.`, [was, ...(now ? [now] : [])], { conf: Math.max(was.confidence, now ? Math.min(0.9, now.confidence) : 0) }) : null;
        }
        return now ? fromFacts(`You work at ${now.object}.`, [now]) : null;
      }
      case "job": {
        const r = current(personal.lookup({ subj: "me", rel: "role" }))[0];
        const w = current(personal.lookup({ subj: "me", rel: "works_at" }))[0];
        if (r && w) return fromFacts(`You are ${/^[aeiou]/i.test(r.object) ? "an" : "a"} ${r.object} at ${w.object}.`, [r, w]);
        if (r) return fromFacts(`You are ${/^[aeiou]/i.test(r.object) ? "an" : "a"} ${r.object}.`, [r]);
        return w ? fromFacts(`You work at ${w.object}.`, [w]) : null;
      }
      case "contact": {
        // A person the user's own words put at one of their organisations.
        const org = personal.entity(p.org);
        if (!org || org.kind !== "org") return null;
        const people = current(personal.about(org.id)?.links || []).filter(f => f.rel === "works_at" && f.subj !== "me");
        if (!people.length) return null;
        const names = [...new Set(people.map(f => f.subject))];
        return fromFacts(`Your contact${names.length > 1 ? "s" : ""} at ${org.label} ${names.length > 1 ? "are" : "is"} ${list(names)}.`, people);
      }
      case "clients": {
        // The user's own company is never their client.
        const own = new Set(current(personal.lookup({ subj: "me", rel: "works_at" })).map(f => f.obj));
        const fs = current(personal.lookup({ subj: "me", rel: "client" })).filter(f => !own.has(f.obj));
        const names = fs.map(f => f.object);
        // The graph's clients too ("Northwind Bakery is your client"), once each.
        for (const g of graphClients()) if (!names.some(n => n.toLowerCase() === g.label.toLowerCase())) names.push(g.label);
        if (!names.length) return null;
        const conf = fs.length ? Math.min(...fs.map(f => f.confidence)) : Math.min(GRAPH_MAX, ...graphClients().map(g => g.confidence));
        return { line: names.length === 1 ? `Your client is ${names[0]}.` : `Your clients are ${list(names)}.`, facts: fs, conf };
      }
      case "uses": {
        const fs = current(personal.lookup({ subj: "me", rel: "uses" })).filter(f => inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You use ${list(fs.map(f => f.object))}.`, fs);
      }
      case "prefers": {
        const fs = current(personal.lookup({ subj: "me", rel: "prefers" }))
          .filter(f => p.options.length ? p.options.some(o => hasWord(f.object, o)) : inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You prefer ${fs[0].object}.`, [fs[0]]);
      }
      case "owns": {
        const fs = current(personal.lookup({ subj: "me", rel: "owns" })).filter(f => inCategory(f.object, p.cat));
        if (!fs.length) return null;
        return fromFacts(`You have ${list(fs.map(f => (/^[aeiou]/i.test(f.object) ? "an " : "a ") + f.object))}.`, fs);
      }
      case "myname": {
        const f = current(personal.lookup({ subj: "me", rel: "name" }))[0];
        if (f) return fromFacts(`Your name is ${f.object}.`, [f]);
        // Who the user is, as they set it up (config.me): known, but no conversation said it.
        if (me?.name) return { line: `Your name is ${me.name}.`, facts: [], conf: 0.9, sessions: 0 };
        return null;
      }
      case "who": {
        let e = personal.entity(p.name);
        // "who is owen price" when only "owen" was ever said: the one person of that first name,
        // as long as no other surname is known for them.
        if (!e && /\s/.test(p.name)) { const f0 = personal.entity(p.name.split(/\s+/)[0]); if (f0 && f0.kind === "person" && !/\s/.test(f0.label)) e = f0; }
        if (!e || e.id === "me") return null;
        const links = current(personal.about(e.id)?.links || []).filter(f => f.subj === "me");
        // The most specific word: a daughter is a child too, and "daughter" says more.
        const SPECIFIC = ["spouse", "partner", "mother", "father", "son", "daughter", "sister", "brother", "pet", "friend", "child", "colleague"];
        const f = links.filter(l => PEOPLE.has(l.rel)).sort((a, b) => SPECIFIC.indexOf(a.rel) - SPECIFIC.indexOf(b.rel))[0] || links[0];
        if (!f) {
          // Someone memory knows only by what they are: "Bram works at Northwind Bakery, your client.", "Mags is an accountant."
          const w = current(personal.lookup({ subj: e.id, rel: "works_at" }))[0], r = current(personal.lookup({ subj: e.id, rel: "role" }))[0];
          if (w) return fromFacts(`${e.label}${r ? ` is ${art(r.object)} at` : " works at"} ${w.object}${isClient(w.object) ? ", your client" : ""}.`, r ? [w, r] : [w]);
          if (r) return fromFacts(`${e.label} is ${art(r.object)}.`, [r]);
          return null;
        }
        if (!PEOPLE.has(f.rel)) {
          // Someone at an organisation: "Bea works at Northwind Bakery, your client."
          const w = current(personal.lookup({ subj: e.id, rel: "works_at" }))[0];
          if (w) return fromFacts(`${e.label} works at ${w.object}${isClient(w.object) ? ", your client" : ""}.`, [w, f]);
        }
        // The name asked about when it is one of theirs (a rival name is still theirs, less surely).
        const names = personal.lookup({ subj: e.id, rel: "name" });
        const nm = names.find(x => x.object.toLowerCase() === p.name.toLowerCase()) || current(names)[0];
        const label = nm ? nm.object : e.label;
        const role = PEOPLE.has(f.rel) ? kinWord(e.id, ROLE_WORD[f.rel]) : null;
        const line = role ? `${label} is your ${role}.`
          : f.rel === "client" ? `${label} is your client.` : f.rel === "works_at" ? `You work at ${label}.`
          : f.rel === "owns" ? `${label} is yours.` : f.rel === "uses" ? `You use ${label}.` : `${label}: ${f.rel.replace(/_/g, " ")}.`;
        return fromFacts(line.replace(/^([a-z])/, c => c.toUpperCase()), nm ? [f, nm] : [f]);
      }
      case "of": {
        // Read on that person only: never the user's own fact, never just their name.
        const s = subjectOf(p.who);
        if (!s) return null;
        const one = rel => current(personal.lookup({ subj: s.id, rel }))[0];
        const S = s.label;
        switch (p.rel) {
          case "role": {
            const r = one("role"), w = one("works_at");
            if (r) return fromFacts(`${S} is ${art(r.object)}${w ? ` at ${w.object}` : ""}.`, w ? [r, w] : [r]);
            return w ? fromFacts(`${S} works at ${w.object}.`, [w]) : null;
          }
          case "works_at": { const w = one("works_at"); return w ? fromFacts(`${S} works at ${w.object}.`, [w]) : null; }
          case "lives_in": { const f = one("lives_in"); return f ? fromFacts(`${S} lives in ${f.object}.`, [f]) : null; }
          case "from": { const f = one("from"); return f ? fromFacts(`${S} is from ${f.object}.`, [f]) : null; }
          case "breed": { const f = one("breed"); return f ? fromFacts(`${S} is ${art(f.object)}.`, [f]) : null; }
          case "color": { const f = one("color"); return f ? fromFacts(`${S} is ${f.object}.`, [f]) : null; }
          case "diet": { const f = one("diet"); return f ? fromFacts(`${S} is ${f.object}.`, [f]) : null; }
          default: {
            // Their relative: "Seren is Rhodri's wife."
            if (!String(p.rel).startsWith("kin:")) return null;
            const word = p.rel.slice(4), rel = relOfRole(roleOf(word) || "");
            const fs = current(personal.lookup({ subj: s.id, rel }));
            return fs.length ? fromFacts(`${S}'s ${fs.length > 1 ? pluralOf(word) : word} ${fs.length > 1 ? "are" : "is"} ${list(fs.map(f => f.object))}.`, fs) : null;
          }
          case "age": { const f = one("age"); return f ? fromFacts(`${S} is ${f.object}.`, [f]) : null; }
          case "hobby": {
            const fs = current(personal.lookup({ subj: s.id, rel: "hobby" }));
            return fs.length ? fromFacts(`${S} ${s.id === "me" ? "enjoy" : "enjoys"} ${list(fs.map(f => f.object))}.`, fs) : null;
          }
          case "car": {
            const d = one("drives");
            const f = d || current(personal.lookup({ subj: s.id, rel: "owns" })).find(x => x.obj.startsWith("vehicle:"));
            return f ? fromFacts(`${S} ${d ? "drives" : "has"} ${carText(f).text}.`, [f]) : null;
          }
          case "prefers": {
            const fs = current(personal.lookup({ subj: s.id, rel: "prefers" })).filter(f => inCategory(f.object, p.cat || null));
            return fs.length ? fromFacts(`${S} prefers ${fs[0].object}.`, [fs[0]]) : null;
          }
        }
      }
      case "carFate": {
        const e = personal.entity(p.car);
        if (!e || e.kind !== "vehicle") return null;
        const owns = personal.lookup({ subj: "me", rel: "owns" }).filter(f => f.obj === e.id);
        const now = owns.find(f => f.current) || current(personal.lookup({ subj: "me", rel: "drives" })).find(f => f.obj === e.id);
        if (now) return fromFacts(`You still have the ${e.label}.`, [now]);
        // Owning is never single-valued, so an owns fact that is no longer current was ended:
        // sold, traded in or scrapped (the store's ended:owns).
        return owns.length ? fromFacts(`You sold the ${e.label}.`, [owns[0]]) : null;
      }
      case "diet": {
        const f = current(personal.lookup({ subj: "me", rel: "diet" }))[0];
        if (!f) return null;
        const k = x => String(x).toLowerCase().replace(/[^a-z]/g, "");
        // Yes when the fact is the diet asked; otherwise what the fact says, never a bare "No".
        const yes = p.asked && (k(f.object) === k(p.asked) || hasWord(f.object.replace(/-/g, " "), p.asked.replace(/-/g, " ")));
        return fromFacts(`${yes ? "Yes, you" : "You"} are ${f.object}.`, [f]);
      }
      default: return null;
    }
  };

  /** The graph's clients: org nodes with a client_of edge to the user. */
  const graphClients = () => {
    if (!graph) return [];
    try {
      return /** @type {any[]} */ (db.prepare(`SELECT n.label, e.confidence FROM memory_edges e JOIN memory_nodes n ON n.id = e.src
        WHERE e.room = '*' AND e.rel = 'client_of' AND e.valid_to IS NULL`).all()).map(r => ({ label: String(r.label), confidence: Number(r.confidence) }));
    } catch { return []; }
  };
  const isClient = label => {
    const l = String(label).toLowerCase();
    return current(personal.lookup({ subj: "me", rel: "client" })).some(f => f.object.toLowerCase() === l) || graphClients().some(g => g.label.toLowerCase() === l);
  };

  /** People outside the user's life: the graph ("Dana Reyes works at Harlow Legal"). */
  const byGraph = (/** @type {Parsed} */ p) => {
    if (!graph) return null;
    if (p.kind === "contact") {
      const org = graph.resolve(p.org);
      if (!org) return null;
      const fs = graph.facts({ about: String(org.id), limit: 50 }).facts.filter(f => f.rel === "works_at" && f.object?.id === org.id);
      if (!fs.length) return null;
      const people = [...new Set(fs.map(f => String(f.subject.label)))];
      return { line: `Your contact${people.length > 1 ? "s" : ""} at ${org.label} ${people.length > 1 ? "are" : "is"} ${list(people)}.`, graphFacts: fs,
        conf: Math.min(GRAPH_MAX, ...fs.map(f => f.confidence)) };
    }
    // "where does dana reyes work": a person outside the user's life, by the graph.
    if (p.kind === "of" && p.who.name && (p.rel === "works_at" || p.rel === "role")) {
      const g = byGraph({ kind: "who", name: String(p.who.name) });
      return g && g.graphFacts[0]?.rel === "works_at" ? g : null;
    }
    if (p.kind === "who") {
      const n = graph.resolve(p.name);
      if (!n || !["person", "org", "name"].includes(String(n.kind))) return null;
      // A partial match only counts when every word asked is in the name found.
      const label = String(n.label).toLowerCase();
      if (!p.name.split(/\s+/).every(w => hasWord(label, w))) return null;
      const fs = graph.facts({ about: String(n.id), limit: 20 }).facts.filter(f => f.rel !== "mentioned_in" && f.subject?.id === n.id && !f.until);
      if (!fs.length) return null;
      const f = fs.find(x => x.rel === "works_at") || fs[0];
      const org = f.object?.label;
      const line = `${f.text}${f.rel === "works_at" && org && isClient(org) ? ", your client" : ""}.`;
      return { line, graphFacts: [f], conf: Math.min(GRAPH_MAX, f.confidence) };
    }
    return null;
  };

  // ---- meaning and keywords: the user's own words about themselves

  const FIRST = /^(?:i|i'm|i've|i'd|i am|my|we|we're|our)\b/i;
  const HYPO = /\b(?:if|suppose|supposing|imagine|pretend|hypothetically|assume|assuming|wish|let's say|what if|as if|for example|e\.g\.)\b/i;
  const QUESTION = /\?\s*$|^(?:who|what|which|where|when|why|how|do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/i;
  const SWAP = [[/\bI am\b/g, "you are"], [/\bI'm\b/g, "you're"], [/\bI've\b/g, "you've"], [/\bI'd\b/g, "you'd"], [/\bI was\b/g, "you were"],
    [/\bI\b/g, "you"], [/\bmyself\b/gi, "yourself"], [/\bmy\b/gi, "your"], [/\bmine\b/gi, "yours"], [/\bme\b/g, "you"], [/\bwe\b/gi, "you"], [/\bour\b/gi, "your"]];
  const toYou = s => {
    let out = s.replace(/[.!\s]+$/, "");
    for (const [re, to] of SWAP) out = out.replace(/** @type {RegExp} */ (re), /** @type {string} */ (to));
    out = cap(out);
    return out.length > 120 ? out.slice(0, 119).replace(/\s+\S*$/, "") + "..." : out + ".";
  };
  const hybridIndex = () => { try { return Boolean(db.prepare("SELECT 1 FROM recall_vectors LIMIT 1").get()); } catch { return false; } };

  /**
   * A said line from recall, or null. With a key noun (the question named a relation), only a
   * sentence that states it ("my dentist is ...") answers.
   * @param {string} q @param {string|null} noun @param {{ project_cwds?: string[] }} o
   */
  const bySaid = async (q, noun, o) => {
    if (!call) return null;
    const asked = normalize(q).split(" ").filter(w => !STOP.has(w) && w.length > 2);
    if (!asked.length && !noun) return null;
    const qf = normalize(q);
    const tries = hybridIndex() ? [{ hybrid: true, via: "meaning" }, { hybrid: false, via: "keyword" }] : [{ hybrid: false, via: "keyword" }];
    for (const t of tries) {
      const r = await call("recall.search", { q, limit: 10, per_session: 1, ...(o.project_cwds?.length ? { project_cwds: o.project_cwds } : {}), ...(t.hybrid ? {} : { hybrid: false }) });
      const hits = Array.isArray(r?.data) ? r.data : r?.data?.hits || [];
      for (const h of hits) {
        if (h.role === "assistant") continue;
        if (/^Capsule: /.test(String(h.name || h.title || "")) || (scratch && h.cwd && String(h.cwd).startsWith(scratch))) continue;
        const text = String(h.text || h.snippet || "").replace(/[«»]/g, "");
        const nt = normalize(text);
        if (qf.split(" ").length >= 3 && nt.includes(qf)) continue;   // the question itself, asked before
        for (const s of text.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim())) {
          if (!FIRST.test(s) || QUESTION.test(s) || HYPO.test(s)) continue;
          const ns = normalize(s);
          if (noun) {
            if (!new RegExp(`\\bmy ${esc(noun)} (?:is|was|called|named)\\b`).test(ns)) continue;
          } else if (!asked.some(w => hasWord(ns, w))) continue;
          const session = String(h.session);
          const sn = sessQ()?.get(session);
          return { line: toYou(s), conf: Math.min(SAID_MAX, 0.4), via: t.via,
            source: { session, seq: Number(h.seq), name: sn ? String(/** @type {any} */ (sn).name || /** @type {any} */ (sn).title || "") || null : h.name || null, quote: s.length > 200 ? s.slice(0, 197) + "..." : s, ts: Number(h.ts) || null } };
        }
      }
    }
    return null;
  };

  /**
   * A line the person told memory (memory.remember) that no rule could read, found by its words:
   * newest first, the same filters as a said line.
   * @param {string} q @param {string|null} noun
   */
  const byTold = (q, noun, strict = false) => {
    const asked = normalize(q).split(" ").filter(w => !STOP.has(w) && w.length > 2);
    if (!asked.length && !noun) return null;
    for (const told of personal.toldAll({ limit: 500 })) {
      for (const s of told.text.split(/(?<=[.!?])\s+/).map(x => x.trim())) {
        if (!FIRST.test(s) || QUESTION.test(s) || HYPO.test(s)) continue;
        const ns = normalize(s);
        // Told on purpose, so every word asked (any ending) is enough, as is a stated relation.
        const has = w => new RegExp(`(^|[^a-z0-9])${esc(w.replace(/(?:es|s|ed|ing)$/, "") || w)}[a-z]{0,3}($|[^a-z0-9])`).test(ns);
        const stated = noun && new RegExp(`\\bmy ${esc(noun)} (?:is|was|called|named)\\b`).test(ns);
        if (!stated && (strict || !(noun ? asked.length && asked.every(has) : asked.some(has)))) continue;
        return { line: toYou(s), conf: SAID_MAX, source: { session: `told:${told.id}`, seq: 0, name: "told to memory", quote: s.length > 200 ? s.slice(0, 197) + "..." : s, ts: told.ts } };
      }
    }
    return null;
  };

  const OF_NOUN = /** @type {Record<string, string>} */ ({ role: "job", works_at: "employer", lives_in: "home", from: "hometown", breed: "breed", color: "colour",
    diet: "diet", car: "car", "car:detail": "car", prefers: "favourite" });
  /** The key noun of a relation question, for the said filter: "son", "dentist", "phone". */
  const nounOf = (/** @type {Parsed} */ p) => {
    switch (p.kind) {
      case "kin": return p.word;
      case "attr": return p.noun || null;
      case "owns": case "uses": return p.cat || null;
      case "prefers": return p.cat ? `favourite ${p.cat}` : p.options[0] || "preference";
      case "birthday": return "birthday";
      case "born": return "birthplace";
      case "car": return "car";
      case "lives": return "home";
      case "work": return "company";
      case "clients": return "client";
      case "myname": return "name";
      case "who": return p.name;
      case "contact": return "contact";
      // Someone else's attribute takes only a line that states it: "my wife's job is ...".
      case "of": return `${p.who.me ? "" : p.who.kin || p.who.name} ${OF_NOUN[p.rel] || p.rel}`.trim();
      case "carFate": return p.car;
      case "diet": return "diet";
      default: return null;
    }
  };

  /**
   * @param {{ q: string, project_cwds?: string[], sources?: boolean }} input
   * @returns {Promise<Answer>}
   */
  return async function answer({ q, project_cwds = [], sources = false }) {
    const t0 = performance.now();
    const n = sources ? SOURCES_ASKED : SOURCES;
    const done = (/** @type {Partial<Answer>} */ r) => ({ answer: null, confidence: null, kind: null, from: 0, facts: [], sources: [], via: null, ...r, ms: round(performance.now() - t0) });
    const text = String(q ?? "").trim();
    if (!text) return done({});
    const p = parse(text);
    if (p) {
      const f = byFact(p);
      if (f && f.conf >= MAYBE) {
        const conf = round(f.conf);
        const line = conf >= SURE ? f.line : "Maybe " + f.line.replace(/^Yes, /, "").replace(/^(Your|You|you)\b/, w => w.toLowerCase());
        const from = f.sessions ?? (f.facts.length ? Math.max(...f.facts.map(x => x.sessions)) : 0);
        return done({ answer: line, confidence: conf, kind: "fact", from, facts: f.facts.map(factOut), sources: sourcesOf(f.facts, n), via: "fact" });
      }
      const g = byGraph(p);
      if (g && g.conf >= MAYBE) {
        const conf = round(g.conf);
        const src = g.graphFacts.filter(x => x.ref).slice(0, n).map(x => {
          const turn = turnQ()?.get(x.ref.session, x.ref.seq);
          return { session: x.ref.session, seq: x.ref.seq, name: x.ref.name || null, quote: turn ? quoteOf(/** @type {any} */ (turn).text, [x.subject?.label, x.object?.label]) : "", ts: x.seen || null };
        });
        return done({ answer: conf >= SURE ? g.line : "Maybe " + g.line, confidence: conf, kind: "fact", from: evidenceSessions(g.graphFacts),
          facts: g.graphFacts.map(x => ({ id: x.id, subject: x.subject?.label, rel: x.rel, object: x.object?.label, confidence: x.confidence, sessions: evidenceSessions([x]), first_seen: x.since ?? null, last_seen: x.seen ?? null })),
          sources: src, via: "fact" });
      }
    }
    // No fact. A vehicle memory never heard of is no relation: its words are searched as before.
    const pq = p && p.kind === "carFate" && personal.entity(p.car)?.kind !== "vehicle" ? null : p;
    // A line told to memory outright comes before anything said in passing. Someone else's
    // attribute takes only a line that states it, never one that merely names them.
    const t = byTold(text, pq ? nounOf(pq) : null, pq?.kind === "of");
    if (t) return done({ answer: t.line, confidence: round(t.conf), kind: "said", from: 1, facts: [], sources: [t.source], via: "keyword" });
    // A relation question takes only a sentence that states that relation.
    const s = await bySaid(text, pq ? nounOf(pq) : null, { project_cwds });
    if (s) return done({ answer: s.line, confidence: round(s.conf), kind: "said", from: 1, facts: [], sources: [s.source], via: s.via });
    return done({});
  };

  /** How many conversations support graph facts. */
  function evidenceSessions(fs) {
    try {
      const q = db.prepare(`SELECT COUNT(DISTINCT v.session) n FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge
        WHERE e.room = '*' AND e.src = ? AND e.rel = ? AND e.dst = ?`);
      return Math.max(0, ...fs.map(f => { const [a, r, b] = String(f.id).split("|"); return Number(/** @type {any} */ (q.get(a, r, b))?.n || 0); }));
    } catch { return 0; }
  }
}

/** Is a value one of a category's ("Neovim" is an editor)? No category: everything is. */
function inCategory(value, cat) {
  if (!cat) return true;
  const v = String(value).toLowerCase();
  if (hasWord(v, cat) || hasWord(v, cat.replace(/s$/, ""))) return true;
  const members = CATEGORY[cat] || CATEGORY[cat.split(" ").pop() || ""] || [];
  return members.some(m => hasWord(v, m));
}

function pluralOf(w) {
  const irregular = { child: "children", wife: "wives", mom: "moms", mum: "mums" };
  return irregular[w] || (w.endsWith("s") ? w : w + "s");
}

