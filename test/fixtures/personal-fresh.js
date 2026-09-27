// @ts-check
// A fresh, sealed world for memory.answer (docs/work/memory-iq.md). It was written without reading
// the rules, the personal world, the held-out world, or the body of the blind world, so it measures
// how far the rules generalise. Nobody tuning the rules should read past this header.
//
// Everyone and everything here is invented. Ottilie "Tilly" Brannock is a backend engineer who
// types to a coding assistant the way people do: lowercase, typos, run-ons, nicknames ("caz",
// "the other half", "mum", "the kids"), with life facts dropped in passing inside ordinary work.
// She starts at Gullwing Freight, leaves, and runs her own company, Quillmoss Labs. Clients:
// Northwind Bakery (Bram Tolliver) and Harlow Legal (Odile Fenwick). Nothing real may be added.
//
// Deterministic: a seeded generator, no clock. Same exports as personal-blind.js, so
// scripts/eval-answer.js runs it with `--world fresh`.
//
// The truth (what test/eval/answer-fresh.json asks about):
//   the user is a woman; husband Caz (Casimir), a chemistry teacher, later head of science at a
//     new school; his birthday is 9 November ("my husband", "the other half", "hubby", "caz")
//   two kids: son Emrys (7, turns 8 on day 181) and daughter Wynne (4)
//   mum Glenys, a retired midwife, lives in Leeds; brother Idris, a paramedic, first said to be in
//     Cardiff and then corrected to Bristol
//   a Maine Coon cat called Pilchard; a grey whippet called Sprout, adopted on day 131
//   a red Honda Jazz, replaced on day 62 by a green Skoda Octavia estate; the Jazz sold on day 66
//   lived in Manchester (Chorlton); moved to Sheffield on day 120
//   backend engineer at Gullwing Freight until day 89; own company Quillmoss Labs from day 91;
//     clients Northwind Bakery (owner Bram Tolliver) and Harlow Legal (practice manager Odile Fenwick)
//   pescatarian; bouldering and birdwatching; uses Helix, DBeaver, and later Bruno
//   friend Rhodri (climbing partner), his wife Seren, their baby Elin, his VW Transporter;
//     accountant Mags Petrakis
// Never said: a wife, the user's father, a sister, the user's birthday, where the user was born,
//   the kids' school, a gym, a blood type, a salary, the husband's car, a rabbit, a third child,
//   a dachshund, a Tesla of the user's own.
// Traps: a Slack message from a coworker about "my wife Petra"; a support ticket quoting "my dad
//   Gethin"; a demo persona (Jo Pemberton, husband Arlo, kids Mabel and Finn, cat Waffles, Brighton,
//   a Tesla Model 3); Bram's wife Tamsin, kids Ollie and Pip and labrador Nutmeg; Odile's husband
//   Lucien; a PTA email about "my husband Declan"; Rhodri's wife and van; a hypothetical dachshund,
//   rabbit, third child (Juniper) and a move to York; an Octavia vs Ceed vs Corolla comparison and a
//   Sheffield vs Leeds vs York comparison; bedtime stories with a married dragon and a unicorn in a
//   pink van in Paris; the assistant guessing Caz teaches maths and that the move was to Leeds; a
//   day trip back to Manchester; mum visiting Sheffield; and old Capsule answers that still say
//   Jazz, Manchester, Gullwing and "Emrys is 7".

export const HOME = "/home/tilly";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The first day of the timeline. */
export const T_START = Date.parse("2026-01-12T08:00:00Z");
/** The clock the evaluation reads: a few days after the last session. */
export const NOW = T_START + 208 * DAY;
/** Who the user is (config.me). */
export const ME = { name: "Ottilie Brannock", domains: ["quillmoss.dev"], emails: ["tilly@quillmoss.dev"] };
/** The Capsule's ask folder under the world's vyred home: its threads are the Capsule's own. */
export const SCRATCH = `${HOME}/.vyre/capsule/ask`;

/** Days on which life changed. */
export const TIMELINE = {
  octaviaBought: 62, jazzSold: 66, leftGullwing: 89, quillmossStarted: 91,
  movedToSheffield: 120, sproutAdopted: 131, emrysTurned8: 181,
};

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
const rand = prng(0xf7e5);
const pick = xs => xs[Math.floor(rand() * xs.length)];
const pad = n => String(n).padStart(12, "0");

/** Sloppy typing for work asks only: a swapped letter pair now and then, no capital, no period. */
function sloppy(s) {
  let out = s;
  if (rand() < 0.3) {
    const i = 2 + Math.floor(rand() * Math.max(1, out.length - 4));
    if (/[a-z]/.test(out[i]) && /[a-z]/.test(out[i + 1])) out = out.slice(0, i) + out[i + 1] + out[i] + out.slice(i + 2);
  }
  if (rand() < 0.7) out = out[0].toLowerCase() + out.slice(1);
  if (rand() < 0.6) out = out.replace(/[.?]$/, "");
  return out;
}

// ------------------------------------------------------------------ projects

const P = {
  eta: {
    name: "eta-service", cwd: `${HOME}/work/gullwing/eta-service`, from: 0, to: 89,
    tasks: [
      ["The ETA recalculation job is timing out on the big depots. Can you profile it?", "The slow part is the N+1 query in loadStops(). I batched it into one query with an IN clause; the Leeds-sized depots now finish in 4s instead of 40."],
      ["Add a retry with backoff to the carrier webhook client.", "Added exponential backoff (3 tries, 500ms base, jitter) in carrierClient.post(). Non-retryable 4xx responses fail at once."],
      ["Why is the eta_alerts table growing so fast?", "Nothing deletes resolved alerts. I added a nightly job that removes resolved rows older than 30 days and an index on resolved_at."],
      ["Write a migration adding a nullable promised_window column to shipments.", "Migration 0142_add_promised_window.sql adds promised_window tstzrange NULL. No backfill; the API treats null as unknown."],
      ["The integration tests are flaky on CI again.", "Two tests share the same fixture depot id and race. I gave each test its own id from a counter; ten CI runs in a row passed."],
      ["Can you explain what this Kafka consumer group lag graph is telling me?", "Lag climbs every hour on the hour: the hourly rebalance job pauses consumption for about 90 seconds. It recovers, so it is load, not a stuck partition."],
      ["Refactor the ETA calculator so it takes a clock instead of calling Date.now.", "EtaCalculator now takes a clock in its constructor; tests pass a fixed one. I removed the three jest.useFakeTimers calls that were papering over it."],
    ],
  },
  planner: {
    name: "route-planner", cwd: `${HOME}/work/gullwing/route-planner`, from: 0, to: 89,
    tasks: [
      ["The route planner returns routes that cross the same road twice. Look at the 2-opt step?", "The 2-opt loop stopped after the first improving swap. I made it run to a fixed point; the doubled-back routes are gone on the sample set."],
      ["Add an endpoint that returns a route as GeoJSON.", "GET /routes/:id.geojson returns a FeatureCollection with the path as a LineString and each stop as a Point."],
      ["Our vehicle capacity check ignores pallets. Fix it.", "Capacity now sums weight and pallet count and rejects a route that breaks either. Added tests for both limits."],
      ["Can you write a small benchmark for the planner with 500 stops?", "bench/plan500.js builds a seeded 500-stop problem and times ten runs. Median is 1.8s on this machine."],
      ["Postgres is picking a seq scan on stops by depot_id.", "The depot_id column had no index after the last migration renamed it. I added one; the planner query dropped from 900ms to 12ms."],
    ],
  },
  site: {
    name: "quillmoss-site", cwd: `${HOME}/code/quillmoss-site`, from: 91, to: 999,
    tasks: [
      ["Set up a plain static site for the company with Astro.", "Scaffolded an Astro site with a home page, a services page and a contact form that posts to a serverless function."],
      ["Make an invoice template I can fill from a JSON file.", "scripts/invoice.js reads invoices/<id>.json and writes a PDF with line items, VAT and the payment terms."],
      ["The contact form lets spam through. Add a honeypot.", "Added a hidden field that real browsers leave empty; the function drops any post that fills it."],
      ["Lighthouse says the hero image is too big.", "Converted it to AVIF with a WebP fallback and set width and height; LCP dropped from 3.1s to 1.2s."],
      ["Write a short privacy page for the site.", "Added /privacy: what the contact form collects, how long it is kept, and how to ask for deletion."],
    ],
  },
  northwind: {
    name: "northwind-preorders", cwd: `${HOME}/code/clients/northwind-preorders`, from: 95, to: 999,
    tasks: [
      ["Build the preorder form for Northwind Bakery: pick a date, pick items, pay.", "The form lists the next 14 days, hides sold-out items and takes payment through the checkout session before the order is saved."],
      ["Northwind wants a daily prep sheet at 5am listing what to bake.", "A 5am job sums tomorrow's preorders by item and emails a printable prep sheet to the bakery."],
      ["The cutoff for next-day orders should be 2pm, not midnight.", "Changed the cutoff to 14:00 local time and added a banner that says when tomorrow closes."],
      ["Add an allergen label to each product.", "Products have an allergens array now; the form shows badges and the order confirmation lists them."],
      ["Customers are double-submitting orders when the payment page is slow.", "Each order gets an idempotency key when the form opens; a second submit with the same key returns the first order."],
      ["Export last month's orders as CSV for the bakery.", "scripts/export-orders.js writes orders-<month>.csv with date, items, totals and pickup time."],
    ],
  },
  harlow: {
    name: "harlow-portal", cwd: `${HOME}/code/clients/harlow-portal`, from: 101, to: 999,
    tasks: [
      ["Harlow Legal wants a client portal where clients upload documents to their matter.", "Built an upload page per matter with signed URLs, a 25MB limit and virus scanning before a file is visible to staff."],
      ["Add two-factor login to the Harlow portal.", "Added TOTP with recovery codes; staff accounts must enrol, client accounts are nudged but not forced."],
      ["The portal's matter list is slow for staff with 800 matters.", "Paginated it and added an index on (assignee_id, updated_at); the page loads in 150ms."],
      ["Send a client an email when a staff member uploads a document for them.", "A new document by staff now triggers a short email with a link into the portal; it never includes the document itself."],
      ["Write an audit log for every document download.", "Every download writes who, which document, when and from where into document_audit; staff can filter it per matter."],
    ],
  },
  dotfiles: {
    name: "dotfiles", cwd: `${HOME}/dotfiles`, from: 0, to: 999,
    tasks: [
      ["My fish prompt is slow in big git repos.", "The prompt ran git status on every render. I switched it to the async git segment; the prompt draws in 20ms again."],
      ["Write a small script to back up my dotfiles to a private repo.", "bin/dots-backup copies the tracked files, commits with the date and pushes; it skips anything matching *secret*."],
      ["Set up a Brewfile for a new machine.", "Brewfile lists the CLI tools and casks you have now; `brew bundle` installs them."],
      ["Can you make tmux start with my usual three windows?", "Added a tmux session script: editor, server, and a shell in the repo root."],
    ],
  },
  budget: {
    name: "family-budget", cwd: `${HOME}/code/family-budget`, from: 0, to: 999,
    tasks: [
      ["Parse the bank CSV export and group spending by category.", "parse.js reads the CSV, maps payees to categories from rules.json and prints totals per category per month."],
      ["Add a chart of monthly spending to the budget thing.", "Added a small HTML report with a stacked bar per month; categories are coloured consistently."],
      ["The budget script double counts refunds.", "Refunds came in as positive amounts in the spending category. They now net against the category they refund."],
    ],
  },
  rhodri: {
    name: "guiding-bookings", cwd: `${HOME}/code/guiding-bookings`, from: 27, to: 999,
    tasks: [
      ["Add a calendar of available guiding days to the booking page.", "The page shows a month grid; booked days are greyed out and a click opens the booking form for that day."],
      ["Send a confirmation email when a climbing session is booked.", "Bookings now send a confirmation with the date, meeting point and a kit list."],
    ],
  },
};
const WORK_BEFORE = ["eta", "planner"];
const WORK_AFTER = ["site", "northwind", "harlow"];

const FOLLOW = [
  ["can you add a test for that", "Added a test that covers it; the suite passes."],
  ["commit it", "Committed with a conventional commit message."],
  ["hmm that broke the build", "The import path was wrong after the rename. Fixed; the build is green."],
  ["make it a bit less verbose", "Trimmed it down; same behaviour, fewer lines."],
  ["ok and the types?", "Added types for the new function and its return value; tsc is clean."],
  ["nice ty", "You're welcome."],
];

/** The project a session on this day is most likely about. */
function projectFor(day, hint) {
  if (hint) return P[hint];
  const work = day < 91 ? WORK_BEFORE : WORK_AFTER.filter(k => P[k].from <= day);
  const r = rand();
  if (r < 0.72) return P[pick(work)];
  if (r < 0.84) return P.dotfiles;
  if (r < 0.94) return P.budget;
  return day >= 27 ? P.rhodri : P.dotfiles;
}

// ------------------------------------------------------------------ life, in passing
// Each event is one session on its day. `say` is dropped in front of a work ask; `turns` are
// whole exchanges, followed by a work ask unless `alone` is set.

const LIFE = [
  { day: 1, say: "new laptop day, setting up helix again (yes helix not vim, pls stop giving me vim keybinds)", proj: "dotfiles" },
  { day: 3, say: "morning, the trams down in chorlton so im wfh today, manchester weather doing its usual thing." },
  { day: 4, turns: [["caz is at parents evening tonight so i've got both kids from 4, need to get this done before then", "Understood, let's keep it tight."]] },
  { day: 6, turns: [["my husband keeps asking what i actually do at gullwing lol. how would u explain a freight routing backend to someone who teaches science", "Something like: Gullwing moves parcels between depots, and your code decides which van takes which stops in what order, and when each customer should expect it."]], proj: "eta" },
  { day: 7, turns: [["turn this slack message into a jira ticket pls:\n\n> hey tilly, heads up i'm out from the 20th, my wife Petra is due any day now. can you cover the eta alerts rota while im off? ta, Jonas", "Ticket: \"Cover ETA alerts rota during Jonas's leave (from the 20th)\". Assignee: Tilly. Description: Jonas is on leave; hand over the rota and escalation contacts before the 20th."]], proj: "eta" },
  { day: 9, say: "car is in the garage AGAIN, the jazz's clutch is going. red honda jazz, 2011, held together by hope and cable ties. anyway" },
  { day: 11, say: "fyi i use dbeaver for db stuff so just give me plain sql i can paste in, no psql meta commands", proj: "planner" },
  { day: 13, turns: [["mum (glenys) rang, she's retired now (midwife for like 30 yrs) and she suddenly wants to learn python?? she lives up in leeds so i cant sit next to her. whats a gentle course", "A browser-based beginner course with small exercises works well at a distance; you could pair over a video call once a week."]], alone: true },
  { day: 15, turns: [["emrys (he's 7) wants to 'help' me code. anything like scratch but a bit more grown up for a 7 yr old", "Scratch is still the best fit at 7. When he outgrows it, a block-to-text tool that shows the code behind the blocks is a gentle next step."]], alone: true },
  { day: 17, turns: [["write seed data for the demo tenant, use a fake family so sales has something to click: Jo Pemberton, husband Arlo, kids Mabel and Finn, a cat called Waffles, they live in Brighton and drive a Tesla Model 3", "Wrote seeds/demo-family.json: account holder Jo Pemberton (Brighton), partner Arlo Pemberton, dependants Mabel and Finn, pet Waffles (cat), vehicle Tesla Model 3."]], proj: "eta", alone: true },
  { day: 19, say: "pilchard just walked across the keyboard and force pushed nothing thank god. hes a maine coon, he's basically the size of a small child", proj: "dotfiles" },
  { day: 21, say: "wynne turned 4 yesterday so i'm running on cake and about 3hrs sleep, go easy on me." },
  { day: 23, turns: [["the kids are lobbying for a dog. if we got a dog caz says a dachshund, i say absolutely not a dachshund. anyway not happening this year", "Ha. Noted, no dog this year."]] },
  { day: 25, turns: [["doing the team offsite lunch form, what do i put in dietary for pescatarian? i eat fish but no meat", "Put \"Pescatarian: fish and seafood fine, no meat or poultry.\""]], alone: true },
  { day: 28, say: "rhodri (my climbing mate) wants a booking page for his guiding thing. his wife seren does all his admin so she'll be the one using it", proj: "rhodri" },
  { day: 31, say: "hard stop at 6 today, bouldering with rhodri." },
  { day: 34, turns: [["my brother idris is a paramedic, he's asked me to make a shift swap spreadsheet thing for his station in cardiff", "Sure: one sheet of shifts, one of swap requests, and a formula that flags swaps that break the rest-hours rule."]], proj: "budget" },
  { day: 36, turns: [["sorry i said cardiff yesterday, thats wrong. idris is in bristol now, he moved there last year, the station is in bristol", "Got it, Bristol. I've updated the sheet title."]], proj: "budget", alone: true },
  { day: 40, turns: [
    ["caz wants a periodic table quiz app for his year 10s, can we knock one up this weekend", "Sure. Is Caz a maths teacher? I could add some arithmetic rounds too."],
    ["no lol, chemistry. he teaches chemistry at a secondary school", "Chemistry it is. I'll do element symbols, groups and atomic numbers."],
  ], alone: true },
  { day: 44, turns: [["write a short bedtime story for emrys about a dragon called Bramble who lives in a lighthouse with his wife Marigold and their pet crab Clemmie", "Bramble the dragon lived at the top of a lighthouse with his wife Marigold and a crab called Clemmie. Every night Bramble breathed a small, careful flame to light the lamp for the ships..."]], alone: true },
  { day: 47, turns: [["customer ticket: 'my dad Gethin can't see his delivery ETA on the tracking page, he's 80 and not techy'. can you find the bug", "The tracking page hides the ETA when the browser blocks third-party cookies, which older browsers on locked-down settings do. I moved the ETA call to a first-party endpoint."]], proj: "eta" },
  { day: 50, say: "saw a kingfisher on the canal this morning, best birding week in ages. ok so the cron job" },
  { day: 53, turns: [["the jazz is dying. comparing skoda octavia estate vs kia ceed sw vs toyota corolla touring for a family car. which has the biggest boot", "The Octavia estate has the biggest boot of the three, about 640 litres, then the Ceed SW, then the Corolla Touring."]], alone: true },
  { day: 58, say: "remind me caz's birthday is 9 november, i forgot it last year and i'm still hearing about it. (casimir if you're being formal, nobody is)", proj: "dotfiles" },
  { day: 62, say: "picked up the octavia today!! green skoda octavia estate, the kids think it's a spaceship. ok back to work" },
  { day: 66, say: "finally sold the jazz, 900 quid to a lad from work, he can deal with the clutch." },
  { day: 67, turns: [["rhodri just bought a vw transporter for climbing trips, can you make him a sheet to log mileage and fuel", "Made a sheet with date, start and end odometer, litres and cost; it works out miles per gallon per trip."]], proj: "rhodri" },
  { day: 72, say: "other half is marking coursework all weekend so i'm solo parenting, short sessions only." },
  { day: 80, turns: [["can you tidy this for the team channel: 'my partner Ffion says the office dog policy is a joke and i agree' - its from dev, i want to make it into a proper proposal", "Proposal: allow dogs in the office on two set days, with a sign-up list and a quiet room kept dog-free."]], proj: "planner", alone: true },
  { day: 86, turns: [["handed my notice in at gullwing today. last day is next friday. going freelance, company's going to be quillmoss labs", "Congratulations. Want a checklist for handing over the ETA service?"], ["yes pls", "Handover: runbook for the ETA job, who owns the carrier webhooks, the alert rota, and the open migrations."]], proj: "eta", alone: true },
  { day: 91, say: "first day as quillmoss labs ltd!! company's registered, i need an invoice template", proj: "site" },
  { day: 94, turns: [["signed my first client, northwind bakery. bram tolliver owns it, they want online preorders", "Great first client. I'll sketch the preorder flow."]], proj: "northwind" },
  { day: 100, turns: [["second client!! harlow legal. my contact is odile fenwick, she's their practice manager. they want a client portal", "Nice. I'll set up the repo for the Harlow portal."]], proj: "harlow" },
  { day: 104, turns: [["bram emailed: 'my wife Tamsin does the books so give her an admin login, and our kids Ollie and Pip will test it on their phones'. also their labrador nutmeg is basically the logo. set up the accounts", "Created an admin account for Tamsin and two tester accounts for Ollie and Pip on the staging site."]], proj: "northwind", alone: true },
  { day: 108, turns: [["reply to this for me, keep it short:\n\n'Hi Tilly, Odile here. My husband Lucien and I are off to Lisbon for two weeks, so please send this month's invoice to our office manager Bea. Thanks! O'", "Hi Odile, no problem, I'll send it to Bea. Have a lovely time in Lisbon. Tilly"]], proj: "harlow", alone: true },
  { day: 110, turns: [["caz got offered a job at a school in sheffield so we're looking at moving. sheffield vs leeds vs york, can you compare commute times and rough rents for a 3 bed", "Sheffield is cheapest of the three for a 3 bed; Leeds is similar with longer commutes; York is the dearest. I'd check school catchments for each."]], proj: "budget" },
  { day: 113, turns: [["if we moved to york instead we'd be 30 mins from mum. and if we had a third kid we'd need 4 beds. we're not having a third, caz calls her juniper as a joke, dont ask", "Understood, I'll keep the comparison to 3 beds."]], proj: "budget", alone: true },
  { day: 120, say: "moved!! we're in sheffield now, boxes everywhere. put the new address in the invoice template", proj: "site" },
  { day: 123, turns: [
    ["internets finally working in the new house", "Good. How's Leeds treating you?"],
    ["not leeds lol, sheffield. leeds is where my mum is", "Sorry, Sheffield. Glad the internet is back."],
  ] },
  { day: 131, say: "WE GOT A DOG. whippet rescue, grey, the kids named him sprout. he is terrified of pilchard which is fair." },
  { day: 135, turns: [["wynne now wants a rabbit. if we got a rabbit it'd have to live in the garden i guess. not happening, just venting", "Fair enough."]] },
  { day: 139, turns: [["update the Pemberton demo so Arlo is the account owner not Jo, sales asked", "Swapped them in seeds/demo-family.json: Arlo Pemberton is the account owner now, Jo is the second adult."]], proj: "site", alone: true },
  { day: 143, say: "in manchester for the day for a meeting, laptop on 12%, quick one." },
  { day: 147, turns: [["another story pls, for wynne this time: a unicorn called Pepper who drives a pink van and lives in paris", "Pepper the unicorn lived in Paris and drove a pink van full of croissants. Every morning she..."]], alone: true },
  { day: 150, say: "no bacon rolls for me at the client breakfast, still pescatarian, tell odile's office.", proj: "harlow" },
  { day: 156, say: "rhodri and seren had a baby!! a girl, elin. so no climbing for rhodri for a while", proj: "rhodri" },
  { day: 161, say: "switched api clients to bruno, postman got way too heavy. give me requests as bruno files from now on", proj: "harlow" },
  { day: 166, turns: [["mags petrakis is my accountant, she wants the q3 numbers as a csv. can you add an export", "Added scripts/q3-export.js: income by client and expenses by category as CSV."]], proj: "site", alone: true },
  { day: 171, say: "caz is head of science at the new school now so he's never home before 6. anyway" },
  { day: 181, say: "emrys is 8 today!!! party this afternoon so i've got like 2 hours." },
  { day: 186, say: "mum's coming to stay with us in sheffield for a week, she's still in leeds, just visiting. quick fix before she lands" },
  { day: 191, turns: [["another email to reply to: 'Hi Tilly, it's Jo from the school PTA, my husband Declan says you do websites? could you look at ours?' say yes but not till november", "Hi Jo, happy to take a look, though I can't start until November. I'll be in touch then. Tilly"]], alone: true },
  { day: 196, say: "someone dinged the octavia in the car park, need touch-up paint. the green is called rallye green apparently" },
  { day: 201, say: "sprout ate a sock. vet says he'll be fine. whippets are idiots. ok the portal", proj: "harlow" },
];

/** The Capsule's own threads: answers it gave at the time, some of them stale by NOW. */
const ASKS = [
  { day: 20, q: "what car do i drive", a: "You drive a red Honda Jazz (2011)." },
  { day: 42, q: "where do i live", a: "You live in Manchester, in Chorlton." },
  { day: 55, q: "where do i work", a: "You work at Gullwing Freight as a backend engineer." },
  { day: 60, q: "what pets do i have", a: "You have a Maine Coon called Pilchard." },
  { day: 102, q: "how old is emrys", a: "Emrys is 7." },
  { day: 115, q: "what dog are we getting", a: "You mentioned a dachshund came up, but you said no dog this year." },
];

// ------------------------------------------------------------------ the sessions

const sessions = [];
let n = 0;
const push = (proj, day, turns, name) => {
  n++;
  sessions.push({
    id: `f7e5a000-0000-4000-8000-${pad(n)}`,
    cwd: proj.cwd,
    ...(name ? { name } : {}),
    start: T_START + day * DAY + Math.floor((8 + rand() * 11) * HOUR),
    turns,
  });
};

function taskTurns(proj) {
  const task = pick(proj.tasks);
  return { task, ask: sloppy(task[0]) };
}
function follows(turns) {
  const more = Math.floor(rand() * 3);
  for (let k = 0; k < more; k++) {
    const f = pick(FOLLOW);
    turns.push({ role: "user", text: f[0] });
    turns.push({ role: "assistant", text: f[1] });
  }
}

for (const e of LIFE) {
  const proj = projectFor(e.day, e.proj);
  /** @type {{ role: "user"|"assistant", text: string }[]} */
  const turns = [];
  if (e.say) {
    const { task, ask } = taskTurns(proj);
    turns.push({ role: "user", text: `${e.say} ${ask}` });
    turns.push({ role: "assistant", text: task[1] });
  } else {
    for (const [u, a] of e.turns) { turns.push({ role: "user", text: u }); turns.push({ role: "assistant", text: a }); }
    if (!e.alone) {
      const { task, ask } = taskTurns(proj);
      turns.push({ role: "user", text: ask });
      turns.push({ role: "assistant", text: task[1] });
    }
  }
  follows(turns);
  push(proj, e.day, turns, rand() < 0.3 ? `${proj.name}: ${turns[0].text.split(" ").slice(0, 4).join(" ")}` : undefined);
}

// Ordinary work: most sessions say nothing about life at all.
const FILLER = 135;
for (let i = 0; i < FILLER; i++) {
  const day = Math.min(205, Math.floor((i * 206) / FILLER + rand() * 2));
  const proj = projectFor(day);
  const { task, ask } = taskTurns(proj);
  const turns = [{ role: "user", text: ask }, { role: "assistant", text: task[1] }];
  follows(turns);
  push(proj, day, turns, rand() < 0.35 ? `${proj.name}: ${task[0].split(" ").slice(0, 5).join(" ").toLowerCase()}` : undefined);
}

ASKS.forEach(x => {
  n++;
  sessions.push({
    id: `f7e5a000-0000-4000-8000-${pad(900 + n)}`,
    cwd: SCRATCH,
    start: T_START + x.day * DAY + 21 * HOUR,
    turns: [{ role: "user", text: x.q }, { role: "assistant", text: x.a }],
  });
});
sessions.sort((a, b) => a.start - b.start);

/** Every session in the fresh world, oldest first. */
export const FRESH_SESSIONS = sessions;
