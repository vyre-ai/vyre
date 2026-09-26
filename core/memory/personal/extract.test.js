// @ts-check
// Personal extraction, one turn at a time. The quiet failures this guards against: someone
// else's wife becoming the user's, a hypothetical or a question read as a fact, Claude's words
// or a pasted letter read as the user's, and a rule set too slow to run on every turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPersonal } from "./extract.js";

/** The claims as "subj|rel|obj" strings, for readable asserts. */
const said = (text, opts) => extractPersonal(text, opts).claims.map(c => `${c.subj}|${c.rel}|${c.obj}`).sort();
const has = (text, want, opts) => { const got = said(text, opts); for (const w of [].concat(want)) assert.ok(got.includes(w), `${JSON.stringify(text)}\n  missing ${w}\n  got ${JSON.stringify(got)}`); };
const none = (text, opts) => assert.deepEqual(said(text, opts), [], JSON.stringify(text));
const WIFE = ["me|spouse|kin:spouse", "kin:spouse|name|lit:Jordan"];

test("personal extract: pure, and quiet on odd input", () => {
  const t = "My wife Jordan loves Seattle.";
  assert.deepEqual(extractPersonal(t), extractPersonal(t));
  for (const x of ["", null, undefined, 42, {}]) assert.deepEqual(extractPersonal(/** @type {any} */ (x)).claims, []);
});

test("personal extract: every way of naming the wife", () => {
  for (const t of ["I'm picking up my wife Jordan at six.", "My wife, Jordan, loves Seattle.", "Jordan (my wife) says hi.",
    "Thanks to Jordan, my wife.", "My wife's name is Jordan.", "My wife is Jordan."]) has(t, WIFE);
  const c = extractPersonal("My wife Jordan says hi.").claims.find(x => x.rel === "name");
  assert.equal(c?.conf, 0.9);
  assert.equal(c?.method, "rule");
});

test("personal extract: 'my wife is' needs a name; 'picking up my wife' links nothing but sets the focus", () => {
  const tired = said("My wife is tired today.");
  assert.ok(!tired.some(x => x.includes("|name|")), JSON.stringify(tired));
  const r = extractPersonal("I'm picking up my wife from the airport.");
  assert.ok(!r.claims.some(x => x.rel === "name"));
  assert.equal(r.focus?.ref, "kin:spouse");
});

test("personal extract: birthdays, by name, by pronoun, by role", () => {
  has("My wife Jordan is great. Her birthday is 14 March.", [...WIFE, "kin:spouse|birthday|lit:14 March"]);
  has("Jordan's birthday is on the 14th of March.", "name:Jordan|birthday|lit:14 March");
  has("My wife's birthday is March 14th, 1988.", "kin:spouse|birthday|lit:14 March 1988");
  has("My birthday is 2 June.", "me|birthday|lit:2 June");
  // The previous turn's focus carries "her" across.
  const prev = extractPersonal("My wife Jordan says hi.").focus;
  has("Her birthday is 14 March.", "kin:spouse|birthday|lit:14 March", { prev });
  has("She works at Harlow Legal now.", "kin:spouse|works_at|org:Harlow Legal", { prev });
  // And a name from the previous turn is her too.
  has("Jordan's birthday is 14 March.", "kin:spouse|birthday|lit:14 March", { prev });
  // With no one to mean, or two, "her" means nothing.
  none("Her birthday is 14 March.");
  const two = extractPersonal("My wife Jordan and my mum Dana came over. Her birthday is 14 March.");
  assert.ok(!two.claims.some(c => c.rel === "birthday"), JSON.stringify(two.claims));
  // Someone else named before the pronoun makes it ambiguous.
  assert.ok(!said("Dana said her birthday is 14 March.", { prev }).some(x => x.includes("birthday")));
});

test("personal extract: relatives, children and pets", () => {
  has("My mother Dana lives in Portland.", ["me|mother|kin:mother", "kin:mother|name|lit:Dana", "kin:mother|lives_in|place:Portland"]);
  has("My dad Sam is visiting.", ["me|father|kin:father", "kin:father|name|lit:Sam"]);
  has("My sister Juno called.", ["me|sister|kin:sister", "kin:sister|name|lit:Juno"]);
  has("My brother Kit moved to Denver.", ["kin:brother|name|lit:Kit"]);
  has("My son Sam starts school.", ["me|son|kin:son", "kin:son|name|lit:Sam"]);
  has("My daughter Juno drew this.", ["me|daughter|kin:daughter", "kin:daughter|name|lit:Juno"]);
  has("My partner Jordan cooked.", ["me|partner|kin:partner", "kin:partner|name|lit:Jordan"]);
  has("My husband Sam cooked.", ["me|spouse|kin:spouse", "kin:spouse|name|lit:Sam"]);
  has("My kids Sam and Juno love the park.", ["me|child|kin:child", "kin:child|name|lit:Sam", "kin:child|name|lit:Juno"]);
  has("My dog Kit is sick.", ["me|pet|kin:dog", "kin:dog|name|lit:Kit"]);
  has("Our cat is called Juno.", []);
  has("My cat Juno sleeps all day.", ["me|pet|kin:cat", "kin:cat|name|lit:Juno"]);
});

test("personal extract: where the user lives and comes from", () => {
  has("I live in Portland.", "me|lives_in|place:Portland");
  has("We moved to Seattle in May.", "me|lives_in|place:Seattle");
  has("Since we moved to Seattle, things are calmer.", "me|lives_in|place:Seattle");
  has("I'm from Denver originally.", "me|from|place:Denver");
  has("I'm based in Austin.", "me|lives_in|place:Austin");
});

test("personal extract: cars, owned, driven, sold and mentioned", () => {
  has("I own a Volvo XC90.", "me|owns|vehicle:Volvo XC90");
  has("I drive a Tesla Model 3.", ["me|drives|vehicle:Tesla Model 3", "me|owns|vehicle:Tesla Model 3"]);
  has("My car is a 2019 Subaru Outback.", "me|owns|vehicle:Subaru Outback");
  has("We sold the Volvo last week.", "me|ended:owns|vehicle:Volvo");
  assert.ok(!said("We sold the Volvo last week.").includes("me|owns|vehicle:Volvo"));
  has("The Volvo needs a service.", "me|owns|vehicle:Volvo");
  const m = extractPersonal("The Volvo needs a service.").claims[0];
  assert.equal(m.conf, 0.7);
  none("The Ford Foundation funds it.");
  none("The Tesla earnings call is today.");
});

test("personal extract: work, clients, tools, preferences, the user's name", () => {
  has("I work at Northwind Bakery.", "me|works_at|org:Northwind Bakery");
  has("I run Harlow Legal.", ["me|works_at|org:Harlow Legal", "me|role|lit:owner"]);
  has("I'm the office manager at Harlow Legal.", ["me|works_at|org:Harlow Legal", "me|role|lit:office manager"]);
  has("Harlow Legal is a client.", "me|client|org:Harlow Legal");
  has("Our client Northwind Bakery called.", "me|client|org:Northwind Bakery");
  has("I use Neovim for everything.", "me|uses|tool:Neovim");
  has("My editor is Zed.", "me|uses|tool:Zed");
  has("I prefer tabs over spaces.", "me|prefers|lit:tabs over spaces");
  has("My name is Alex.", "me|name|lit:Alex");
  has("Hi, I'm Alex.", "me|name|lit:Alex");
  none("I'm Canadian.");
  none("I'm Sorry about that.");
  none("I'm a big fan of the work at Harlow Legal.");
});

test("personal extract: negations, hypotheticals and questions are not facts", () => {
  none("If my wife were Jordan, she'd laugh.");
  none("Suppose I live in Portland.");
  none("It's not my wife Jordan, it's someone else.");
  assert.ok(!said("My wife isn't Jordan.").some(x => x.includes("Jordan")));
  none("What is my wife's name?");
  none("Where do I live");
  none("Do you know where I live?");
  none("I don't live in Portland.");
  none("I no longer live in Portland.");
  none("I never owned a Tesla.");
});

test("personal extract: other people's relatives are theirs", () => {
  none("Dana's husband Luis is a chef.");
  none("Dana, my wife's friend, came over.");
  none("Sam's wife Juno lives in Denver.");
  none("My friend's wife Jordan is lovely.");
  const r = said("My wife's brother Sam is visiting.");
  assert.ok(!r.some(x => x.includes("Sam")), JSON.stringify(r));
});

test("personal extract: Claude's words are weak, never the user's name, and only about 'you'", () => {
  const r = extractPersonal("Your wife Jordan will love that.", { role: "assistant" });
  assert.ok(r.claims.length > 0);
  assert.ok(r.claims.every(c => c.conf === 0.35 && c.method === "assistant"));
  has("Your wife Jordan will love that.", WIFE, { role: "assistant" });
  none("Nice to meet you, Alex. I'm Claude.", { role: "assistant" });
  none("My name is Claude and I live in the cloud.", { role: "assistant" });
  none("My wife Jordan is here.", { role: "assistant" });
});

test("personal extract: quoted, pasted and fenced material is not the user speaking", () => {
  none("> my wife Jordan said hi");
  none("```\nmy wife Jordan lives in Seattle\n```");
  none("Here is the diff: `my wife Jordan`");
  const letter = "Can you tighten this cover letter?\n\nDear Hiring Manager,\n\nI am applying for the design role. My spouse and I moved to Seattle last year, and I live in Seattle now. My wife Jordan works at Harlow Legal.\n\nSincerely,\nAlex\n";
  none(letter);
  // A long paste is read only for its first-person sentences.
  const long = "The applicant's husband Luis lives in Denver. ".repeat(120) + " By the way, I live in Portland.";
  assert.deepEqual(said(long), ["me|lives_in|place:Portland"]);
});

test("personal extract: cues are the personal sentences no rule understood", () => {
  const r = extractPersonal("Heading home, my wife needs the car at five. I no longer live in Portland.");
  assert.ok(r.cues.some(c => c.includes("Portland")), JSON.stringify(r));
  assert.deepEqual(extractPersonal("Refactor the db layer and run the tests.").cues, []);
  assert.deepEqual(extractPersonal("My wife hates my car.", { role: "assistant" }).cues, []);
});

test("personal extract: 20,000 turns in well under 2 s", () => {
  const T = [
    "Let's refactor the db layer and run the tests again, then open a PR against main.",
    "My wife Jordan is picking up the Volvo. Her birthday is 14 March.",
    "Here is the stack trace:\n```\nError: boom\n    at run (index.js:10:5)\n```\nany idea what is wrong?",
    "I live in Seattle and work at Northwind Bakery; Harlow Legal is a client.",
    "Can you update the README with the new flags and bump the version? Also check the CI logs for the flaky test. ".repeat(4),
  ];
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 20000; i++) n += extractPersonal(T[i % T.length] + " " + i, { role: i % 2 ? "assistant" : "user" }).claims.length;
  const ms = performance.now() - t0;
  console.log(`# personal extract: 20000 turns in ${Math.round(ms)} ms (${n} claims)`);
  assert.ok(n > 0);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test("personal extract: a car by its model alone, its colour, and the I a diary leaves out", () => {
  has("Just bought a blue Volvo XC40, picking it up tomorrow.", ["me|owns|vehicle:Volvo XC40", "vehicle:Volvo XC40|color|lit:blue"]);
  has("My green Subaru Outback failed its inspection.", ["me|owns|vehicle:Subaru Outback", "vehicle:Subaru Outback|color|lit:green"]);
  has("The Outback is in the shop again.", "me|owns|vehicle:Subaru Outback");
  has("Driving the XC40 to Harlow for the review.", ["me|drives|vehicle:Volvo XC40", "me|owns|vehicle:Volvo XC40"]);
  has("Sold the Outback this weekend.", "me|ended:owns|vehicle:Subaru Outback");
  has("Moved to Seattle last weekend, boxes everywhere.", "me|lives_in|place:Seattle");
  // Only at the start of a sentence, and only in the user's words.
  none("Driving the XC40 to Harlow.", { role: "assistant" });
  none("Sam said moved to Seattle was hard.");
  // A colour with no car is nothing.
  none("The blue logo looks better.");
});

test("personal extract: the user's own company", () => {
  has("My studio, Rivera Studio, needs a cleaner invoice template.", "me|works_at|org:Rivera Studio");
  has("At Rivera Studio we bill monthly.", "me|works_at|org:Rivera Studio");
});

test("personal extract: dictated words are someone else's", () => {
  none("Tomas wants it in his own words. Start with: I, Tomas Park, am the spouse of Lena Park. My wife Lena works as a head baker.");
  none("Write: My wife Casey and I moved to Denver.");
  // What comes before the dictation is still the user's.
  has("My wife Jordan asked for this. Start with: My husband Tomas is a baker.", WIFE);
});
