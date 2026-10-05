// @ts-check
// The world memory.answer is measured against (team/archive/work-journals/memory-iq.md): half a year of one
// person's Claude Code sessions, in which the facts of their life come up the way they really
// do. Rarely as a statement, mostly in passing ("picking up my wife from the airport", "the
// Volvo needs a service"), spread over many sessions, and buried in noise that shares the words:
// other people's spouses, a visa letter full of "spouse", hypotheticals, the same question asked
// before, Claude saying "your wife", and the Capsule's own ask threads.
//
// Everyone and everything here is invented. Alex Rivera runs Rivera Studio; the clients are
// Harlow Legal (Dana Reyes) and Northwind Bakery (Sam Okafor). Nothing real may be added.
//
// Deterministic: a seeded generator, no clock. The same call gives the same sessions, in the
// shape test/fixtures/corpus.js seedRecall(db, sessions) takes.
//
// The truth (what test/eval/answer-gold.json asks about):
//   wife Jordan, birthday 14 March          dog Biscuit, mother Ruth, sister Maya (said once)
//   a green Subaru Outback, sold on day 96; a blue Volvo XC40, bought on day 95
//   lived in Portland, moved to Seattle on day 112 (the newest place must win)
//   works at Rivera Studio (their own), clients Harlow Legal and Northwind Bakery
//   uses Neovim, prefers tea (said once)
// Never said: a son, a daughter, a father, a brother, a cat, a bank, where Alex was born, a gym,
// a phone, a dentist, a favourite restaurant, a blood type.

import { HOME } from "./corpus.js";

export { HOME };
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The first day of the timeline. */
export const T_START = Date.parse("2026-03-02T08:00:00Z");
/** The clock the evaluation reads: a few days after the last session. */
export const NOW = T_START + 190 * DAY;
/** Who the user is (config.me). */
export const ME = { name: "Alex Rivera", domains: ["riverastudio.com"], emails: ["alex@riverastudio.com"] };
/** The Capsule's ask folder under the world's vyred home: its threads are the Capsule's own. */
export const SCRATCH = `${HOME}/.vyre/capsule/ask`;

/** Days on which life changed. */
export const TIMELINE = { volvoBought: 95, subaruSold: 96, movedToSeattle: 112 };

/** mulberry32: small, fast, and the same everywhere. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the dev work (the bulk)

const PROJECTS = [
  { dir: "Work/harlow-site", label: "Harlow site", files: ["intake", "hero", "practice-areas", "contact", "seo"], tables: ["leads", "pages"] },
  { dir: "Work/harlow-intake", label: "Harlow intake", files: ["route", "crm", "summary", "form"], tables: ["leads", "submissions"] },
  { dir: "Work/northwind", label: "Northwind", files: ["invoices", "watcher", "menu", "totals"], tables: ["invoices", "orders"] },
  { dir: "Work/studio-tools", label: "studio tools", files: ["billing", "timesheet", "report", "cli"], tables: ["hours", "clients"] },
  { dir: "dotfiles", label: "dotfiles", files: ["init", "keymaps", "plugins", "statusline"], tables: ["sync"] },
];

/** Dev requests and replies. {f} a file, {t} a table, {p} the project's label, {n} a number. */
const DEV = [
  ["The {p} build fails on the lint step, can you look?", "Fixed: an unused import in src/lib/{f}.ts was failing the lint step. The build passes now."],
  ["Rename the helper in src/lib/{f}.ts to something clearer.", "Renamed it to load{F}Config and updated the four call sites."],
  ["Add a test for the empty input case in {f}.", "Added a test: {f} now returns an empty list instead of throwing on empty input."],
  ["Why is the {p} page slow on mobile?", "The hero image is 3.1 MB. I resized it and added lazy loading; first paint dropped to 1.2 s."],
  ["Bump the dependencies and run the tests again.", "Bumped 14 packages. All {n} tests pass."],
  ["Move the config into a single file under config/.", "Moved it into config/{f}.json and removed the three scattered copies."],
  ["The deploy to staging timed out, retry it.", "Retried. The staging deploy finished in 2 minutes; the timeout was a slow image pull."],
  ["Write a migration that adds a created_at column to {t}.", "Wrote migration 00{n}_add_created_at_to_{t}.sql with a default of now()."],
  ["Check the logs for errors from last night.", "Two errors, both a 502 from the upstream mail service at 03:12. Nothing lost; the retry sent both."],
  ["Refactor {f} so it does not read the file twice.", "It now reads the file once and passes the parsed result down."],
  ["Can you explain what the {f} module does?", "It reads the {t} table, groups rows by week, and hands the totals to the report."],
  ["Add a loading state to the {f} form.", "Added a spinner and disabled the submit button while the request is in flight."],
  ["The {t} query is slow, add an index.", "Added an index on {t}(created_at). The query went from 480 ms to 9 ms."],
  ["Split the long function in src/lib/{f}.ts into smaller ones.", "Split it into three: parse, validate and save. Behaviour is unchanged and the tests pass."],
  ["Format the whole repo with prettier.", "Formatted {n} files. No logic changed."],
  ["Add a README section on running {p} locally.", "Added a Running locally section with the three commands."],
  ["Why does the {f} test flake?", "It depended on the clock. I froze the time in the test and it passed 50 runs in a row."],
  ["Remove the dead code in {f}.", "Removed two unused exports and an old feature flag."],
  ["Set up a preview deploy for every pull request.", "Done. Each pull request gets its own preview URL in a comment."],
  ["Make the {f} error messages friendlier.", "Rewrote six messages so they say what went wrong and what to do next."],
  ["Add type checks to {f}.", "Added @ts-check and fixed the three type errors it found."],
  ["Cache the {t} lookups for a minute.", "Added a 60 second cache in front of the {t} lookups."],
  ["Write a small script to export {t} to CSV.", "Wrote scripts/export-{t}.js; it streams rows so large tables do not fill memory."],
  ["Update the footer year and the contact email.", "Updated both, and the email now comes from one constant."],
  ["Check the site on a narrow screen.", "At 360 px the nav overlapped the logo. I stacked them; it fits now."],
  ["Can you review my last commit?", "Looks right. One note: the error in {f} is swallowed; I would log it."],
  ["Roll back the last deploy, something is off.", "Rolled back to the previous release. The error rate is back to zero."],
  ["Add a health check endpoint.", "Added GET /health returning ok and the build id."],
  ["Write the release notes for this week.", "Drafted notes: {n} fixes, the faster {t} query, and the new preview deploys."],
  ["Clean up the environment variables we no longer use.", "Removed five unused variables from the example env file and the deploy config."],
];

// ------------------------------------------------------------------ what Alex says about life

/**
 * @typedef {{ u: string, a?: string, from?: number, to?: number, n?: number, where?: "dev"|"home"|"any" }} Aside
 * u is the user's words, a Claude's reply (a generic one when absent), [from, to) the days it may
 * be said on, n how many times it is said.
 */

/** @type {Aside[]} */
const ASIDES = [
  // The wife: named rarely, mentioned often.
  { u: "My wife Jordan wants the Harlow site to have a dark mode, she thinks it looks dated.", a: "I can add a dark mode toggle. I'll keep the Harlow colours and darken the background.", n: 2 },
  { u: "Let's wrap this up by five, I'm picking up my wife from the airport.", a: "Sure. I'll have it ready before you go get your wife.", n: 3 },
  { u: "Jordan and I are out tomorrow, so push the deploy to Monday.", a: "Moved the deploy to Monday morning.", n: 3 },
  { u: "Jordan says the Northwind menu font is too small, and she's usually right.", a: "Bumped the menu font from 14 px to 17 px.", n: 2 },
  { u: "Need to leave early today, my wife has a doctor's appointment.", n: 2 },
  { u: "Jordan and I are painting the spare room this weekend, so no work Saturday.", n: 1 },
  { u: "Remind me to book dinner for my wife. Her birthday is on the 14th of March.", a: "I can't set reminders, but I noted it: dinner for your wife's birthday on 14 March.", from: 0, to: 12, n: 1 },
  { u: "Jordan's birthday is 14 March, keep that evening free.", a: "Noted, no calls in the evening on 14 March.", from: 0, to: 12, n: 1 },
  { u: "My wife's birthday was great, thanks for moving the Harlow call.", from: 13, to: 20, n: 1 },
  { u: "Planning ahead: my wife's birthday is on March 14 again next year, and I want to book the same place.", from: 150, to: 185, n: 1 },
  { u: "Jordan wants to see the Northwind bakery we built the site for, we might go on Sunday.", n: 1 },
  // The car: a green Subaru Outback, sold, then a blue Volvo XC40.
  { u: "The Outback is in the shop again, I'll work from home today.", from: 0, to: 90, n: 3 },
  { u: "My green Subaru Outback failed its inspection, so I'm stuck at home.", from: 20, to: 80, n: 1 },
  { u: "Driving the Subaru to Northwind for the photo shoot, back in two hours.", from: 0, to: 90, n: 2 },
  { u: "Just bought a blue Volvo XC40, picking it up tomorrow so I'll start late.", a: "Congratulations. I'll leave the Northwind fixes queued for tomorrow afternoon.", from: 95, to: 96, n: 1 },
  { u: "Sold the Outback this weekend, one less thing to worry about.", from: 96, to: 99, n: 1 },
  { u: "The Volvo needs a service next week, I'll be at the dealer on Tuesday morning.", from: 100, to: 185, n: 2 },
  { u: "Driving the XC40 to Harlow for the review meeting.", a: "Good luck with the review. The Harlow deck is in the shared folder.", from: 100, to: 185, n: 3 },
  { u: "Parked the Volvo outside Northwind, the parking there is terrible.", from: 100, to: 185, n: 2 },
  // Where Alex lives: Portland, then Seattle.
  { u: "It's been raining nonstop here in Portland all week.", from: 0, to: 105, n: 2 },
  { u: "Our place in Portland is too small for a proper office.", from: 0, to: 100, n: 1 },
  { u: "I live in Portland, so schedule the client calls on Pacific time.", from: 0, to: 100, n: 1 },
  { u: "We're moving to Seattle next month, so I'll be offline for two days around the move.", from: 80, to: 105, n: 1 },
  { u: "Moved to Seattle last weekend, boxes everywhere.", from: 112, to: 118, n: 1 },
  { u: "Since we moved to Seattle my drive to the Harlow meetings is longer.", from: 118, to: 185, n: 2 },
  { u: "I live in Seattle now, update my address on the invoices.", a: "Updated the Rivera Studio invoice template with the Seattle address.", from: 118, to: 185, n: 1 },
  { u: "The wifi in the Seattle apartment keeps dropping.", from: 115, to: 185, n: 2 },
  // The dog.
  { u: "Biscuit needs a walk, back in ten.", n: 3 },
  { u: "My dog Biscuit chewed the laptop charger, working from the backup.", n: 1 },
  { u: "Taking Biscuit to the vet at noon.", n: 2 },
  // Family.
  { u: "My mom Ruth is visiting this weekend, so I'm off Friday afternoon.", n: 2 },
  { u: "Call with Ruth, my mother, at six, so let's finish before then.", n: 1 },
  { u: "Ruth wants help setting up her new laptop, I'll do that tonight.", n: 1 },
  { u: "My sister Maya is opening a bakery too, funny enough, she asked who built the Northwind site.", n: 1 },
  // Work.
  { u: "At Rivera Studio we bill monthly, so the invoices go out on the first.", n: 2 },
  { u: "My studio, Rivera Studio, needs a cleaner invoice template.", n: 1 },
  { u: "Harlow Legal is my biggest client, so their fixes come first.", n: 2 },
  { u: "My client Northwind Bakery wants the weekly total on Friday afternoons.", n: 1 },
  { u: "Dana Reyes at Harlow Legal signed off on the homepage.", n: 2 },
  { u: "Sam Okafor from Northwind Bakery called about the invoice watcher.", n: 2 },
  // Tools and taste.
  { u: "I use Neovim, so give me the keybinding, not the VS Code one.", n: 2 },
  { u: "My Neovim config broke after the plugin update.", n: 1 },
  { u: "I prefer tea over coffee, so skip the coffee order for the Harlow meeting.", n: 1 },

  // ---- noise: other people's families, which are not Alex's
  { u: "Dana's husband Luis is joining the Harlow call, add him to the invite.", a: "Added Luis to the Harlow call invite.", n: 2 },
  { u: "Sam's wife Ada runs the front of house at Northwind, send her the menu preview too.", n: 2 },
  { u: "Dana's son Leo drew a sketch for the new Harlow logo.", n: 1 },
  { u: "Sam's cousin lives in Seattle and wants a site for his cafe.", from: 0, to: 60, n: 1 },
  { u: "Northwind switched their bank to Cedar Credit Union, update the payment details on their invoices.", n: 1 },
  // ---- noise: hypotheticals and examples
  { u: "If my wife were a Harlow client, what would the intake form ask her first?", a: "It would ask for her name, the matter type and the best time to call.", n: 1 },
  { u: "Write a test fixture as if my wife were named Casey Hart, with a fake address.", a: "Added a fixture for Casey Hart at 1 Example Street.", n: 1 },
  { u: "Suppose I drove a Tesla, would the parking app still work?", a: "Yes, the parking app does not care what you drive.", n: 1 },
  { u: "Imagine my son wanted a site like Northwind's, how long would it take?", a: "About two weeks for a site of that size.", n: 1 },
];

// ------------------------------------------------------------------ the sessions that are all noise

/** A visa cover letter for someone else, full of spouse, wife and husband. */
const VISA = [
  "Help me draft a visa cover letter for Lena Park. Her spouse Tomas Park will travel with her.",
  "Here is a first draft. Dear Visa Officer, I am writing in support of the application of Lena Park, who will travel with her spouse, Tomas Park.",
  "Tomas wants it in his own words. Start with: I, Tomas Park, am the spouse of Lena Park. My wife Lena works as a head baker.",
  "Updated: I, Tomas Park, am the spouse of Lena Park. My wife Lena works as a head baker and I will accompany her for the full stay.",
  "Add that the spouse's passport number goes in the annex, and that the wife is the main applicant.",
  "Added a line pointing to the annex for the spouse's passport, and made clear Lena is the main applicant.",
  "The sponsor is Priya Anand at Keel & Ash Architects. Mention her once.",
  "Mentioned Priya Anand at Keel & Ash Architects as the sponsor in the second paragraph.",
  "My wife should read this before we send it? No, I mean Lena should read it. Send it to her as a PDF.",
  "Exported the letter as a PDF for Lena Park to review.",
  "Also list the husband's employer and the wife's employer in a small table.",
  "Added a table: Tomas Park, self employed; Lena Park, Northwind Bakery.",
];

/** A KPI report: numbers and client names, nothing personal. */
const KPI = [
  "Build the monthly KPI report for Rivera Studio clients.",
  "Harlow Legal: 42 leads, up 12 percent. Northwind Bakery: 310 orders, up 4 percent. Invoices paid on time: 96 percent.",
  "Add a chart of leads by week for Harlow.",
  "Added a bar chart of Harlow Legal leads by week; the best week had 14.",
  "What is the average invoice for Northwind?",
  "The average Northwind Bakery invoice this month is 318 dollars.",
  "Note that Northwind moved to Cedar Credit Union mid month, so two payments were late.",
  "Noted in the report: two late Northwind payments during their bank switch.",
];

/** The Family intake form for Harlow: spouse fields that describe no one real. */
const FAMILY_FORM = [
  "Harlow wants a family law intake form. Add fields for spouse name, spouse date of birth and children.",
  "Added Spouse name, Spouse date of birth and a repeating Children section to the Harlow intake form.",
  "Add a checkbox: my wife or husband is also a client.",
  "Added the checkbox with the label My wife or husband is also a client.",
  "Validate that the spouse's birthday is a real date.",
  "The spouse date of birth now rejects impossible dates like 31 February.",
];

/** Questions the user asked before, in the Capsule's own threads, and Claude not knowing. */
const ASKED = [
  ["what is my wife's name?", "I can't see your wife's name in this conversation."],
  ["which car do I own?", "I don't have that here. You could tell me and I'll remember it for this session."],
  ["where do I live?", "I don't know where you live from this conversation."],
  ["when is my wife's birthday", "I don't have your wife's birthday in this conversation."],
  ["what's my dog's name", "You haven't told me in this conversation."],
  ["who is my wife", "I don't know from this thread. Your wife might be mentioned in another session."],
  ["what editor do I use", "I can't tell from here."],
  ["which bank do I use?", "I don't know which bank you use."],
  ["what is my son's name", "I don't have that information."],
  ["who are my clients?", "From this thread I can't tell. Harlow Legal came up in another project."],
];

/** Errands at home: short sessions with no code in them. */
const HOME_TASKS = [
  ["Draft a polite email asking the landlord about the heating.", "Here is a draft asking when the heating will be checked, and offering two times."],
  ["Make a packing list for a weekend away.", "Clothes for two days, chargers, the dog's food and lead, and snacks for the drive."],
  ["Plan meals for the week, nothing with mushrooms.", "Seven dinners, no mushrooms: tacos, curry, pasta, soup, stir fry, salmon and pizza."],
  ["Help me compare two phone plans.", "Plan A is cheaper if you use under 10 GB a month; plan B wins above that."],
  ["Write a short thank you note for a neighbour who watched the house.", "Thanks so much for keeping an eye on the place while we were away."],
  ["Summarise this article about home offices.", "It argues for a door that closes, a real chair and daylight from the side."],
  ["What should I check before a long drive?", "Tyres, oil, washer fluid, lights, and that the spare is inflated."],
  ["Make a checklist for moving house.", "Change the address, book movers, pack room by room, label boxes, and move the internet."],
];

// ------------------------------------------------------------------ assembly

/**
 * @param {number} [seed]
 * @returns {import("./corpus.js").Session[]}
 */
export function personalWorld(seed = 7) {
  const rnd = prng(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  let n = 0;
  const id = () => `44444444-dddd-4000-8000-${String(++n).padStart(12, "0")}`;

  /** @type {{ day: number, kind: string, cwd: string, name?: string, turns: string[] }[]} */
  const plan = [];

  // 96 dev sessions, spread evenly over 185 days with a little jitter.
  for (let i = 0; i < 96; i++) {
    const p = PROJECTS[i % PROJECTS.length];
    const day = Math.min(185, Math.floor(i * 185 / 96) + int(0, 1));
    const len = int(6, 8);
    const turns = [];
    const used = new Set();
    for (let k = 0; k < len; k++) {
      let j = int(0, DEV.length - 1);
      while (used.has(j)) j = (j + 1) % DEV.length;
      used.add(j);
      const f = pick(p.files), t = pick(p.tables), num = String(int(12, 480));
      const fill = s => s.replaceAll("{f}", f).replaceAll("{F}", f.charAt(0).toUpperCase() + f.slice(1)).replaceAll("{t}", t).replaceAll("{p}", p.label).replaceAll("{n}", num);
      turns.push(fill(DEV[j][0]), fill(DEV[j][1]));
    }
    plan.push({ day, kind: "dev", cwd: `${HOME}/${p.dir}`, name: i % 4 === 0 ? `${p.label} ${["fixes", "cleanup", "review", "perf"][(i / 4) % 4]}` : undefined, turns });
  }
  // 12 errands at home.
  for (let i = 0; i < 12; i++) {
    const day = Math.floor(i * 180 / 12) + int(1, 5);
    const turns = [];
    const first = i % HOME_TASKS.length;
    for (let k = 0; k < 3; k++) turns.push(...HOME_TASKS[(first + k * 3) % HOME_TASKS.length]);
    plan.push({ day, kind: "home", cwd: HOME, turns });
  }
  // The noise sessions.
  plan.push({ day: 40, kind: "noise", cwd: `${HOME}/Documents/visa`, name: "Visa cover letter", turns: VISA });
  plan.push({ day: 41, kind: "noise", cwd: `${HOME}/Documents/visa`, turns: VISA.slice(0, 6) });
  for (const d of [31, 92, 153]) plan.push({ day: d, kind: "noise", cwd: `${HOME}/Work/studio-tools`, name: "Monthly KPI report", turns: KPI });
  plan.push({ day: 70, kind: "noise", cwd: `${HOME}/Work/harlow-intake`, name: "Family intake form", turns: FAMILY_FORM });
  plan.push({ day: 71, kind: "noise", cwd: `${HOME}/Work/harlow-intake`, turns: FAMILY_FORM.slice(2) });
  // The Capsule's own ask threads, spread over the timeline.
  ASKED.forEach(([q, a], i) => plan.push({ day: 20 + i * 16, kind: "capsule", cwd: SCRATCH, name: `Capsule: ${q.replace(/\?$/, "")}`, turns: [q, a] }));

  // Each aside goes into a session in its window: inside a user turn half the time, as a turn of
  // its own the other half, which is how asides really arrive.
  const hosts = plan.filter(s => s.kind === "dev" || s.kind === "home");
  for (const a of ASIDES) {
    const from = a.from ?? 0, to = a.to ?? 186;
    const window = hosts.filter(s => s.day >= from && s.day < to);
    if (!window.length) throw new Error(`no session between day ${from} and ${to} for: ${a.u}`);
    for (let k = 0; k < (a.n ?? 1); k++) {
      const s = window[Math.floor(rnd() * window.length)];
      const at = 2 * int(0, Math.floor(s.turns.length / 2) - 1);
      if (!a.a && rnd() < 0.5) s.turns[at] = `${a.u} ${s.turns[at]}`;
      else s.turns.splice(at, 0, a.u, a.a || pick(["Noted.", "Understood.", "Sure, no problem.", "Got it."]));
    }
  }

  plan.sort((a, b) => a.day - b.day);
  /** @type {Map<number, number>} */
  const perDay = new Map();
  return plan.map(p => {
    const k = perDay.get(p.day) || 0;
    perDay.set(p.day, k + 1);
    return {
      id: id(), cwd: p.cwd, ...(p.name ? { name: p.name } : {}),
      start: T_START + p.day * DAY + k * 2 * HOUR,
      turns: p.turns.map((text, i) => ({ role: /** @type {"user"|"assistant"} */ (i % 2 ? "assistant" : "user"), text })),
    };
  });
}

/** The world, built once. */
export const PERSONAL_SESSIONS = personalWorld();
