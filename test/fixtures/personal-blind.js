// @ts-check
// A blind world for memory.answer (team/archive/work-journals/memory-iq.md). The personal and held-out worlds are
// both used to tune the extraction rules now, so neither measures generalisation. This one was
// written without reading the rules or either of those worlds' bodies, the way a solo developer
// types to a coding assistant: lowercase, typos, run-ons, nicknames ("dani", "the wife", "ma",
// "the truck"), with life facts dropped in passing inside ordinary app work.
//
// Everyone and everything here is invented. Kit Moreno is a solo freelance app developer who runs
// a one-person LLC, Tinfoil Studio. Clients: Northwind Bakery (Priya Shah) and Harlow Legal
// (Marcus Bell). Nothing real may be added.
//
// Deterministic: a seeded generator, no clock. Same shape as personal-heldout.js, so
// scripts/eval-answer.js runs it with `--world blind`.
//
// The truth (what test/eval/answer-blind.json asks about):
//   wife Dani (Daniela), a nurse, birthday 14 March ("my wife", "the wife", "dani")
//   one daughter, Luna (no son); mother Rosa, who lives in Tucson; a beagle called Biscuit
//   a silver Subaru Outback, sold on day 64; a blue Ford Maverick, bought on day 58
//   lived in Portland, moved to Denver on day 112 (the newest place must win)
//   a solo freelance app developer; LLC Tinfoil Studio; clients Northwind Bakery and Harlow Legal
//   uses Neovim and TablePlus; vegetarian; friend Theo
// Never said: a husband, a son, a cat, a father's name, Kit's own sister or brother, Kit's
// birthday, a bank, a gym, where Kit was born, a blood type, an electric car.
// Traps: Marcus's wife Helen and son Jonah, Priya's husband Arjun and cat Samosa, a demo persona
// (Sofia Reyes, husband Diego, dog Rocket, Austin, a Tesla), Theo's Rivian and his wife Mara, a
// quoted "my dad Frank", a hypothetical cat Mochi and a hypothetical second kid, a Tacoma
// comparison and an EV6 vs Ioniq 5 comparison, a bedtime story for Luna, the assistant guessing
// Seattle, a later trip back to Portland, and old Capsule answers that still say Subaru and Portland.

export const HOME = "/home/kit";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The first day of the timeline. */
export const T_START = Date.parse("2026-02-02T08:00:00Z");
/** The clock the evaluation reads: a few days after the last session. */
export const NOW = T_START + 190 * DAY;
/** Who the user is (config.me). */
export const ME = { name: "Kit Moreno", domains: ["tinfoil.studio"], emails: ["kit@tinfoil.studio"] };
/** The Capsule's ask folder under the world's vyred home: its threads are the Capsule's own. */
export const SCRATCH = `${HOME}/.vyre/capsule/ask`;

/** Days on which life changed. */
export const TIMELINE = { maverickBought: 58, outbackSold: 64, movedToDenver: 112 };

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
const rand = prng(0xb11d);
const pick = xs => xs[Math.floor(rand() * xs.length)];

/** Sloppy typing: a swapped letter pair now and then, sometimes no capital, sometimes no period. */
function sloppy(s) {
  let out = s;
  if (rand() < 0.35) {
    const ws = out.split(" ");
    const i = Math.floor(rand() * ws.length);
    const w = ws[i];
    if (w.length > 4 && /^[a-z]+$/.test(w)) { const j = 1 + Math.floor(rand() * (w.length - 3)); ws[i] = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2); }
    out = ws.join(" ");
  }
  if (rand() < 0.6) out = out[0].toLowerCase() + out.slice(1);
  if (rand() < 0.5) out = out.replace(/[.]$/, "");
  return out;
}

// ------------------------------------------------------------------ the dev work

const PROJECTS = [
  {
    cwd: `${HOME}/code/northwind-app`,
    name: "northwind app",
    tasks: [
      ["The cart total on the Northwind ordering app is off by a cent when you add two croissants. Find it.", "It was float math in src/cart/total.ts. I switched line totals to integer cents and added a test for two croissants plus a baguette."],
      ["Priya Shah wants the menu screen to show sold out items greyed instead of hidden.", "Done. MenuItem now takes a soldOut prop, renders at 40% opacity and disables the add button."],
      ["Push notifications for order ready are firing twice on Android.", "The listener was registered in both App.tsx and OrderScreen. I removed the second one and the notification fires once now."],
      ["Add a pickup time picker, 15 minute slots, only during bakery hours 7 to 3.", "Added PickupPicker with 15 minute slots from 07:00 to 15:00, skipping slots already in the past."],
      ["The Expo build fails on eas with a pod install error.", "The Podfile pinned an old Firebase. I bumped it and the eas build went green."],
      ["Priya asked for a loyalty stamp card, 10 coffees and the next one is free.", "I added a stamps table and a StampCard component. The 11th coffee applies a 100% discount line."],
      ["Write a migration adding allergens to menu_items, a text array.", "Migration 0014_allergens adds allergens text[] default '{}' and the admin form now edits it."],
      ["The Northwind admin dashboard loads slow, like 6 seconds.", "The orders query had no index on created_at. I added one and the dashboard loads in about 400 ms."],
      ["Stripe webhook for Northwind refunds is 400ing.", "The raw body was being JSON parsed before signature verification. I moved the webhook route ahead of the json middleware."],
      ["Make the app icon the new croissant logo Priya sent.", "Replaced assets/icon.png and the adaptive icon foreground, and regenerated the splash."],
    ],
  },
  {
    cwd: `${HOME}/code/harlow-portal`,
    name: "harlow portal",
    tasks: [
      ["Harlow Legal intake form needs a conflict check before it saves the lead.", "I added a conflictCheck step that searches existing matters by party name and flags a match for Marcus to review."],
      ["Marcus Bell wants uploaded documents virus scanned.", "Uploads now go to a quarantine bucket and move to documents only after the scan job marks them clean."],
      ["The portal login magic link expires too fast, clients complain.", "Raised the token lifetime from 10 to 30 minutes and made the expired page offer a new link."],
      ["Add an e-signature step to the retainer flow.", "The retainer page now renders the PDF, captures a typed signature and stores a signed copy with a timestamp."],
      ["Next build is failing on a type error in lib/matters.ts.", "Matter.status was typed as string but compared to an enum. I typed it as MatterStatus and the build passes."],
      ["Marcus wants a weekly email of new intakes every monday.", "A cron route now emails Marcus a summary of the last 7 days of intakes at 8am Monday."],
      ["Harlow wants the client portal in Spanish too.", "I set up next-intl with en and es, and moved the intake copy into messages files."],
      ["Audit log for who viewed which document, Marcus asked for it for compliance.", "Every document view now writes a row to document_views with user, document and time, and there is an admin page listing them."],
      ["The calendar booking widget double books consult slots.", "Two requests could claim a slot at once. I added a unique index on (slot_start, attorney_id) and a retry message."],
      ["Rate limit the public intake endpoint, we got spammed.", "Added a 5 per minute per IP limit and a honeypot field. The spam test script is blocked now."],
    ],
  },
  {
    cwd: `${HOME}/code/tinfoil-site`,
    name: "tinfoil site",
    tasks: [
      ["Update the Tinfoil Studio site case studies with the Northwind app.", "Added a Northwind Bakery case study page with the ordering app screenshots and linked it from the home grid."],
      ["The contact form on my site sends to spam.", "The from address did not match the domain. I set it to hello@tinfoil.studio and added SPF and DKIM notes to the README."],
      ["Make the site dark mode follow the OS.", "The site now reads prefers-color-scheme and the toggle overrides it, saved per visitor."],
      ["Write an invoice generator script, markdown to pdf.", "scripts/invoice.js reads invoices/*.md and writes PDFs with the Tinfoil Studio header."],
    ],
  },
  {
    cwd: `${HOME}/dotfiles`,
    name: "dotfiles",
    tasks: [
      ["My tmux status bar broke after the update.", "The status-right used a removed format. I replaced it and reloaded the config."],
      ["Set up a git alias for a pretty log.", "Added `git lg` for a one-line graph log with dates and authors."],
      ["Telescope is slow in big repos.", "Configured telescope to use ripgrep with a .gitignore aware file finder, which is much faster."],
    ],
  },
];

const FOLLOW = [
  ["Ok nice. Can you also add a test for that.", "Added a test next to it and the suite passes."],
  ["Run the tests again, I think one is flaky.", "Ran it ten times. One snapshot test was date dependent, I froze the clock in it."],
  ["commit that with a sensible message", "Committed as a single conventional commit on the current branch."],
  ["cool, what else is left on this?", "Only the README section and a lint warning in the same file. I fixed the lint warning."],
  ["hmm that broke the build, revert the last bit", "Reverted the last change and the build is green again."],
];

// ------------------------------------------------------------------ the life, in passing

/**
 * What Kit lets slip, by session index (session i happens on day 2i). A string is typed ahead of
 * that session's first request; an object replaces the first exchange with its own turns.
 * @type {Record<number, string | { turns: [string, string][] }>}
 */
const ASIDES = {
  2: "(daycare called, luna has a fever so im half here today)",
  4: "keeping it quiet today, my wife dani just got off three night shifts, shes a nurse, and my keyboard is LOUD.",
  6: {
    turns: [
      ["fwd from marcus, read this and then lets move the demo seed script:\n\n\"Kit, apologies for the delay, my wife Helen and I were at our son Jonah's graduation all weekend. Can we push the demo to Thursday? Best, Marcus Bell, Harlow Legal\"", "Got it, the demo moves to Thursday. I changed the seed script's demo date and the reminder email to match."],
    ],
  },
  8: "walked biscuit (our beagle) in the rain AGAIN, portland in feb is brutal. anyway",
  10: "my mom rosa keeps calling from tucson to get me to fix her ipad over facetime lol. unrelated:",
  12: "fyi im in neovim so dont give me vscode steps.",
  14: {
    turns: [
      ["seed persona for the harlow demo, keep it fake: Sofia Reyes, 34, married to Diego Reyes, one dog named Rocket, lives in Austin TX, drives a Tesla Model 3. generate 20 intake records around her", "Created seed/persona-sofia.json with Sofia Reyes and 20 intake records: a lease dispute, a will update for her and Diego, and so on. All fictional."],
    ],
  },
  16: "dani's birthday is march 14 and i want this done before then so i can actually take the day off",
  18: "if we ever got a cat dani wants to call it Mochi, which, fine. we are not getting a cat. ok the upload bug:",
  20: "grabbing lunch at the veggie place first, been vegetarian like 10 years and the options near here suck.",
  22: {
    turns: [
      ["random but compare the ford maverick and the toyota tacoma for me? the subaru is getting old and biscuit's crate barely fits in the outback", "Maverick: cheaper, hybrid option, about 40 mpg city, 4.5 ft bed. Tacoma: more towing and off road, worse mileage, pricier. For a dog crate and city driving the Maverick is the better fit."],
    ],
  },
  24: "my buddy theo just got a rivian r1s and will not shut up about it lol",
  26: {
    turns: [
      ["wife's bday is the 14th, any gift ideas that arent flowers", "A few: a massage voucher for after her night shifts, a pottery class for two, or a framed print of a place you both like."],
    ],
  },
  28: "> my dad Frank finally retired, party saturday!!\nthats from theos group chat, i gotta leave early saturday so lets wrap this today",
  29: "BOUGHT THE TRUCK. blue ford maverick hybrid. the subaru goes on marketplace this weekend",
  30: {
    turns: [
      ["priya sent this, can you set up the invoice email she wants:\n\n\"Hi Kit! My husband Arjun and I are away next week, our cat Samosa is at the sitter's lol. Please send the invoice to billing@northwindbakery.test. Thanks, Priya Shah, Northwind Bakery\"", "Set the Northwind invoice recipient to billing@northwindbakery.test and scheduled next week's invoice."],
    ],
  },
  32: "sold the outback today to some college kid. kinda sad, that car brought luna home from the hospital",
  34: "tableplus is open on my other monitor and the orders table looks fine to me",
  36: "my kid luna just turned 4 and now she wants to 'help' with the laptop",
  38: {
    turns: [
      ["what time will the monday cron actually fire for me", "It fires at 8am Pacific. Since you're in Seattle, judging by your commit timezone, that's 8am your time."],
      ["im in portland not seattle lol, same timezone though", "Got it, Portland. Same Pacific time, so 8am your time."],
    ],
  },
  40: "put Tinfoil Studio on the invoice footer, thats my llc, not my personal name",
  42: "solo dev life, im the whole company. been a freelance app developer about 3 years now",
  44: {
    turns: [
      ["whats a good gift for someone's sister? asking for dani, her sister is visiting", "Something local: a nice candle from a shop near you, good coffee beans, or a restaurant gift card for the visit."],
    ],
  },
  46: "the maverick fits biscuit's crate no problem. best purchase this year",
  48: "big news, we're moving to denver in june!! dani got a job at a hospital there",
  50: {
    turns: [
      ["compare the kia ev6 and the hyundai ioniq 5 for theo, he wants a second ev for his wife mara", "Both ride on the same platform. The Ioniq 5 has more rear space and a flat floor; the EV6 is sportier with a little more range. For a family car, the Ioniq 5."],
    ],
  },
  52: "boxes everywhere, our portland apartment is chaos",
  56: "made it to denver!! the truck survived the drive with luna and biscuit in the back seat",
  60: "denver is so dry my lips are cracking lol. anyway",
  64: "ma is flying in from tucson to see the new place this weekend so im short on time",
  68: {
    turns: [
      ["write a 5 sentence bedtime story for luna about a dragon named Pepper who has a little sister named Juniper", "Pepper the dragon lived on a cloud with her little sister Juniper. Every night Juniper asked for one more story. Pepper told her about the stars that hummed. Juniper fell asleep before the end. Pepper tucked a cloud around her and flew off to dream."],
    ],
  },
  70: "dani had the weekend off so we took the maverick up into the mountains, first real trip since moving",
  74: "theo's wife mara just had twins, so i'm buying baby stuff for someone else for once",
  76: "priya asked if denver has good bakeries lol. she's not wrong to worry",
  80: "if we ever have a second kid we'd need a bigger place, so, probably not lol",
  84: "my daughter luna drew all over my whiteboard, so if the architecture notes look weird thats why",
  86: "flying back to portland next week for a harlow dinner, weird being a tourist there now that we live in denver",
  88: "the wife worked a double so i'm on luna duty all day, keep answers short",
};

/**
 * Earlier Capsule ask threads: the user's questions and the answers they got at the time. Two of
 * them went stale (the Subaru was sold, the family moved).
 */
const ASKS = [
  { day: 41, q: "what car do i drive", a: "You drive a silver Subaru Outback." },
  { day: 101, q: "where do i live", a: "You live in Portland." },
  { day: 131, q: "whats my dogs name", a: "Your dog is Biscuit." },
  { day: 150, q: "whats my husbands name", a: "I don't know that." },
];

// ------------------------------------------------------------------ assembly

const pad = n => String(n).padStart(12, "0");

/** @type {import("./corpus.js").Session[]} */
const sessions = [];
const N = 90;
for (let i = 0; i < N; i++) {
  const day = 2 * i;
  const aside = ASIDES[i];
  // Life asides about clients happen in that client's repo; the rest wherever the work is.
  let proj = pick(PROJECTS);
  if (typeof aside === "object") {
    const text = aside.turns[0][0].toLowerCase();
    if (text.includes("marcus") || text.includes("harlow")) proj = PROJECTS[1];
    else if (text.includes("priya")) proj = PROJECTS[0];
  }
  const task = pick(proj.tasks);
  /** @type {{ role: "user"|"assistant", text: string }[]} */
  const turns = [];
  if (typeof aside === "object") {
    for (const [u, a] of aside.turns) { turns.push({ role: "user", text: u }); turns.push({ role: "assistant", text: a }); }
    turns.push({ role: "user", text: sloppy(task[0]) });
    turns.push({ role: "assistant", text: task[1] });
  } else {
    const ask = sloppy(task[0]);
    turns.push({ role: "user", text: aside ? `${aside} ${ask}` : ask });
    turns.push({ role: "assistant", text: task[1] });
  }
  const more = Math.floor(rand() * 3);
  for (let k = 0; k < more; k++) {
    const f = pick(FOLLOW);
    turns.push({ role: "user", text: sloppy(f[0]) });
    turns.push({ role: "assistant", text: f[1] });
  }
  sessions.push({
    id: `b11d0000-0000-4000-8000-${pad(i + 1)}`,
    cwd: proj.cwd,
    ...(rand() < 0.4 ? { name: `${proj.name}: ${task[0].split(" ").slice(0, 5).join(" ").toLowerCase()}` } : {}),
    start: T_START + day * DAY + Math.floor((9 + rand() * 9) * HOUR),
    turns,
  });
}
ASKS.forEach((x, j) => {
  sessions.push({
    id: `b11d0000-0000-4000-8000-${pad(900 + j)}`,
    cwd: SCRATCH,
    start: T_START + x.day * DAY + 20 * HOUR,
    turns: [{ role: "user", text: x.q }, { role: "assistant", text: x.a }],
  });
});
sessions.sort((a, b) => a.start - b.start);

/** Every session in the blind world, oldest first. */
export const BLIND_SESSIONS = sessions;
