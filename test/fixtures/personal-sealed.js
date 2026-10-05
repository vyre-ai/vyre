// @ts-check
// A second sealed world for memory.answer (team/archive/work-journals/memory-iq.md). It was written without reading
// the rules, the model prompt, or the body of any other world, so it measures how far the answerer
// generalises. Nobody tuning the rules or the prompt should read past this header.
//
// Everyone and everything here is invented. Ossian "Oss" Treadwell is a data engineer in the north
// east of England who types to a coding assistant the way people do: lowercase, typos, run-ons, no
// apostrophes, nicknames ("the missus", "my other half", "bree", "the kids", "the wee man", "mam",
// "our kid" for his brother, "the pup"), with life facts dropped in passing inside ordinary work.
// Day job at Brackwater Utilities, then Tidewell Health. Side clients: Northwind Bakery (Wendell
// Pike) and Harlow Legal (Lorcan Voss). Nothing real may be added.
//
// Deterministic: a seeded generator, no clock. Same exports shape as personal-blind.js, so
// scripts/eval-answer.js runs it with `--world sealed`.
//
// The truth (what test/eval/answer-sealed.json asks about):
//   the user is a man; wife Bree (Brielle), a physiotherapist, first at the hospital and from day 150
//     at a private clinic in Durham; vegetarian; birthday 2 June
//   two kids: son Corwin (6, turns 7 on day 97) and daughter Nell (3)
//   mam Maureen, lives in Sunderland, a librarian who retired on day 130
//   brother Lorcan ("our kid"), an electrician, first said to be in Gateshead, corrected on day 75 to
//     Whitley Bay
//   a tabby cat called Mungo; a border terrier puppy called Bramble (female), adopted on day 88
//   a blue Vauxhall Astra, traded in on day 55 for a white Kia Niro hybrid
//   lived in Heaton, Newcastle; moved to Durham on day 118
//   data engineer at Brackwater Utilities until day 100; lead data engineer at Tidewell Health from
//     day 102; side work for Northwind Bakery and Harlow Legal
//   coeliac (gluten free); sea swimming (Tynemouth, later Seaham) and chess on lichess
//   uses Zed and DataGrip; swapped Docker Desktop for OrbStack on day 68
//   friend Hamish (swimming), his wife Ffion, twins Rory and Isla (5), his mustard yellow Defender,
//     sold on day 178 for a silver Skoda Kodiaq; friend Tobi (chess); accountant Gwen Halloran;
//     client Wendell Pike (Northwind), wife Sunniva, son Kip, Newfoundland Crumpet, green Berlingo
//     van; client contact Lorcan Voss (Harlow IT manager), partner Anneke, a baby girl, black Volvo XC40
// Never said: a husband, the user's father, a sister, a sister-in-law, the user's birthday, where
//   anyone was born, the kids' school, a gym, a blood type, a salary, the wife's car, a motorbike of
//   his own, twins of his own, a cockapoo, a nephew, a grandmother, an address in Lisbon.
// Traps: a pasted Slack thread (Yusuf, wife Hana, baby Lina); a pasted email (Leanne, husband Raj,
//   son Dev); a support ticket quoting "my mother Edith"; demo seed data (Hollis Fenn, wife
//   Clementine, kids Otto and Bea, cat Pickles, Bath, a red Mini); a persona (Dr Saoirse Lund, GP in
//   York, husband Tomas, two sons); a bedtime story (Sir Wobble, Queen Dahlia, dragon Ember, Norway);
//   Hamish's family, van and swap; Wendell's family, dog and van; Lorcan Voss (same first name as the
//   brother), his partner, baby and car; hypotheticals (a Triumph motorbike, a cockapoo, a move to
//   Lisbon); a planned move to Edinburgh that was cancelled on day 78; a Niro vs Corsa Electric vs
//   MG4 comparison, a Durham vs Newcastle vs Edinburgh comparison and a Niro vs Kodiaq comparison;
//   the assistant guessing Bree is a nurse, Corwin is a nephew and the move was to Edinburgh; a trip
//   back to Newcastle; mam staying in Durham for a weekend; and old Capsule answers that still say
//   Astra, Gateshead, Brackwater, "Corwin is 6" and Newcastle.

export const HOME = "/home/oss";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The first day of the timeline. */
export const T_START = Date.parse("2026-03-02T08:00:00Z");
/** The clock the evaluation reads: a few days after the last session. */
export const NOW = T_START + 210 * DAY;
/** Who the user is (config.me). */
export const ME = { name: "Ossian Treadwell", domains: ["treadwell.dev"], emails: ["oss@treadwell.dev"] };
/** The Capsule's ask folder under the world's vyred home: its threads are the Capsule's own. */
export const SCRATCH = `${HOME}/.vyre/capsule/ask`;

/** Days on which life changed. */
export const TIMELINE = {
  niroBought: 55, astraTradedIn: 55, brotherCorrected: 75, edinburghCancelled: 78,
  brambleAdopted: 88, corwinTurned7: 97, leftBrackwater: 100, startedTidewell: 102,
  movedToDurham: 118, mamRetired: 130, breeToClinic: 150, hamishSoldDefender: 178,
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
const rand = prng(0x5ea1ed);
const pick = xs => xs[Math.floor(rand() * xs.length)];
const pad = n => String(n).padStart(12, "0");

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
  if (rand() < 0.5) out = out.replace(/[.?]$/, "");
  return out;
}

// ------------------------------------------------------------------ the work

const PROJECTS = {
  brackwater: {
    cwd: `${HOME}/work/brackwater-pipelines`, name: "brackwater pipelines", from: 0, to: 100,
    tasks: [
      ["The nightly meter readings DAG failed again on the S3 sensor.", "The sensor was poking a prefix that now has a date partition. I pointed it at the partitioned path and the DAG ran green."],
      ["dbt model stg_readings is taking 40 minutes, make it incremental.", "stg_readings is incremental now on reading_ts with a 2 day lookback. The run takes about 3 minutes."],
      ["Add a data quality test that readings are never negative.", "Added an accepted_range test on reading_kwh with min 0. It found 12 bad rows from one meter, which I quarantined."],
      ["Airflow keeps retrying a task that will never succeed, the source file is gone.", "I made the task raise AirflowFailException on a missing file so it stops retrying and alerts once."],
      ["Snowflake warehouse costs spiked last week, find out why.", "A BI dashboard refreshed every minute against an XL warehouse. I moved it to an S warehouse and a 15 minute refresh."],
      ["The tariffs seed csv has duplicate keys, dbt seed fails.", "Two tariff codes appeared twice with different rates. I kept the newer rows and added a unique test on tariff_code."],
      ["Write a backfill script for March outage events.", "scripts/backfill_outages.py replays the March files through the loader in daily batches and is idempotent."],
      ["Great Expectations suite for customer addresses is flaky.", "The postcode regex rejected valid postcodes with no space. I normalised them before the check and it is stable."],
      ["Make the CI run dbt build only on changed models.", "CI now runs dbt build with state:modified+ against the prod manifest, which cut the job from 25 to 4 minutes."],
      ["Terraform plan wants to recreate the raw bucket, stop it.", "The bucket name had a trailing space in one variable. I fixed the variable and added prevent_destroy."],
    ],
  },
  tidewell: {
    cwd: `${HOME}/work/tidewell-ingest`, name: "tidewell ingest", from: 102, to: 999,
    tasks: [
      ["Set up the repo for the clinic appointments ingest, python, uv, ruff.", "Scaffolded tidewell-ingest with uv, ruff, pytest and a pre-commit config. make check runs all three."],
      ["The HL7 parser chokes on segments with escaped pipes.", "The splitter ignored the escape character. I switched to a tokenizer that honours \\F\\ escapes and added fixtures."],
      ["Mask patient names before the data lands in the analytics schema.", "A masking step now hashes names and dates of birth with a salted key before the load into analytics."],
      ["Write a Dagster asset for daily appointment no-show rates.", "Added no_show_rate_daily as a partitioned asset over appointments, with a freshness policy of 26 hours."],
      ["Postgres replica lag alerts are firing every night at 2am.", "The vacuum on the appointments table ran at 2am on the primary. I moved it to 4am and tuned autovacuum for that table."],
      ["Our DuckDB exports are huge, can we use parquet with zstd.", "Exports now write parquet with zstd level 3. The nightly file dropped from 9 GB to 1.4 GB."],
      ["Add row level security so clinic managers only see their own clinic.", "Added an RLS policy keyed on clinic_id from the session and a test that a manager cannot read another clinic."],
      ["The FHIR bundle loader times out on large practices.", "It posted the whole bundle at once. I batch entries in groups of 200 and the large practice loads in 90 seconds."],
      ["Make a runbook for when the ingest falls behind.", "docs/runbook.md covers checking lag, pausing the sensor, draining the queue and replaying from the last good offset."],
      ["Write tests for the appointment dedupe logic.", "Added eight tests covering same patient same slot, rebooked slots and cancelled then rebooked cases. All pass."],
    ],
  },
  northwind: {
    cwd: `${HOME}/side/northwind-orders`, name: "northwind orders", from: 0, to: 999,
    tasks: [
      ["Northwind Bakery wants a daily orders summary emailed at 6am.", "A cron job now emails the day's wholesale orders, grouped by cafe, to the bakery at 6am."],
      ["The Northwind orders sheet import breaks on dates like 3/4.", "The importer guessed US dates. I forced day first parsing and it reads 3/4 as the 3rd of April."],
      ["Add a route planner for the Northwind delivery van.", "Added a planner that orders the day's drops by distance from the bakery using the postcode lookup table."],
      ["Wholesale price list page needs a print stylesheet.", "Added a print stylesheet that hides the nav, fits the table to A4 and prints the date at the top."],
      ["Northwind stock count form double submits on slow wifi.", "The button now disables on submit and the handler is idempotent on a client generated id."],
      ["Export the month's orders to csv for the accountant.", "scripts/export_month.py writes orders_YYYY_MM.csv with net, VAT and gross columns."],
    ],
  },
  harlow: {
    cwd: `${HOME}/side/harlow-docs`, name: "harlow docs", from: 0, to: 999,
    tasks: [
      ["Harlow Legal doc export to PDF cuts off the last page.", "The page break logic dropped a trailing page with only a signature block. I fixed the overflow check and it renders."],
      ["Add a retention job that archives matters closed over 6 years ago.", "A weekly job moves closed matters older than 6 years to the archive bucket and logs each one."],
      ["Harlow wants a search box across document titles.", "Added full text search on titles with a trigram index. Typing three letters returns results in under 100 ms."],
      ["The Harlow portal password reset email goes to spam.", "The sender domain lacked DKIM. I added the DKIM record notes and switched the from address to the verified domain."],
      ["Write a script to bulk rename scanned files by matter number.", "scripts/rename_scans.py reads the matter number from the cover page barcode and renames each PDF to match."],
      ["Add an audit trail for document downloads.", "Every download writes a row with user, document and time, and there is an admin page to filter them."],
    ],
  },
  chess: {
    cwd: `${HOME}/play/openings`, name: "openings", from: 0, to: 999,
    tasks: [
      ["Pull my last 500 games from the lichess API into sqlite.", "scripts/pull.py streams your games as ndjson from the lichess API and upserts them into games.db."],
      ["Which openings do I lose most with as black.", "From games.db, you score worst in the Caro-Kann Advance, 38 percent over 61 games."],
      ["Make a little chart of my rating over time.", "Added plot_rating.py, which writes rating.png with blitz and rapid lines by month."],
    ],
  },
  dotfiles: {
    cwd: `${HOME}/dotfiles`, name: "dotfiles", from: 0, to: 999,
    tasks: [
      ["My zsh prompt is slow in big repos.", "The git status segment ran on every prompt. I switched it to an async segment and the prompt draws instantly."],
      ["Set up zed keybindings to match my old vim muscle memory.", "Enabled vim mode in Zed and mapped space as leader for file finder and project search."],
      ["Add a git alias to undo the last commit but keep changes.", "Added `git undo` as reset --soft HEAD~1."],
    ],
  },
};

const FOLLOW = [
  ["ok nice. add a test for that too", "Added a test next to it and the suite passes."],
  ["cool commit it", "Committed with a short message describing the change."],
  ["wait ci is red now", "A lint rule flagged an unused import I left behind. Removed it and CI is green."],
  ["can you explain that bit again, the second part", "The second part retries only on transient errors and gives up on anything that will fail again."],
  ["run it again", "Ran it again. Same result, it passes."],
  ["thanks", "You're welcome."],
  ["hmm thats not quite it, try the other way", "Switched to the other approach. It is simpler and the output matches what you expected."],
  ["what did we change in the last session on this", "Last time we changed the config and added a check. Nothing else moved."],
  ["can you make it less verbose", "Trimmed the logging to one line per run and moved the detail behind a debug flag."],
  ["and update the readme", "The README now covers the new step and how to run it locally."],
];

// ------------------------------------------------------------------ life, in passing

/**
 * Each event is a session on its day. `say` prefixes the day's work ask; `turns` are chat before
 * the work; `alone` means the session is only that chat.
 * @type {{ day: number, proj?: string, say?: string, turns?: [string, string][], alone?: boolean }[]}
 */
const EVENTS = [
  { day: 1, say: "morning, back at it. the kids were feral all weekend lol." },
  { day: 3, turns: [
    ["quick one before work, whats a decent gluten free bread in the supermarkets, im coeliac and the missus keeps buying the wrong one", "Look for loaves with the crossed grain symbol. Most supermarkets carry a couple of certified gluten free brands in the free-from aisle."],
  ] },
  { day: 5, say: "sorry if im slow today, mungo was sick on the stairs at 5am. hes our cat, old tabby, 14 now." },
  { day: 7, proj: "brackwater", say: "for context im a data engineer at brackwater utilities, been there about 4 years." },
  { day: 9, turns: [
    ["my other half is on nights at the hospital this week so im doing school run, might be in and out", "No problem, I'll keep answers short."],
    ["her names bree btw (brielle officially), shes a physio", "Noted."],
  ] },
  { day: 10, turns: [
    ["bree says my desk is too low and thats why my back hurts", "She's probably right. As a nurse she'd have seen plenty of posture problems. Try raising the desk so your elbows sit at 90 degrees."],
    ["shes a physio not a nurse haha. anyway", "Sorry, physio. Even better placed to judge your desk then."],
  ] },
  { day: 12, say: "corwins 6 and already asking to learn python, nell is 3 and just wants to bash the keyboard." },
  { day: 14, turns: [
    ["our kid lorcan is coming round tonight to sort the kitchen lights, hes a sparky", "Handy to have an electrician in the family."],
    ["yeah hes in gateshead so its not far", "Good, a short trip for him."],
  ] },
  { day: 16, proj: "harlow", say: "harlow legal want the export fixed, lorcan voss (their it manager) sent the spec over." },
  { day: 18, say: "the astra wont start again, blue vauxhall astra, 11 years old, its on its way out." },
  { day: 20, say: "went sea swimming at tynemouth this morning with hamish, 7 degrees, brain still frozen." },
  { day: 22, proj: "chess", say: "i play a lot of chess on lichess, want to look at my games properly." },
  { day: 25, alone: true, turns: [
    ["can you summarise this slack thread for me\n\nyusuf: sorry team, off from tomorrow, my wife hana is due any day with our second\nclaire: congrats!!\nyusuf: its a girl, were going to call her lina\ndev_ops_bot: on-call rota updated\nclaire: who is covering yusufs pipelines", "Yusuf is off from tomorrow because his wife Hana is about to have their second child, a girl they plan to call Lina. The open question is who covers Yusuf's pipelines while he is away."],
  ] },
  { day: 27, say: "mam still works at the library in sunderland, three days a week. she wants me to look at their slow pc lol." },
  { day: 29, turns: [
    ["make me a tiny birthday reminder script, just a dict of names and dates", "Here's reminders.py with a BIRTHDAYS dict and a check that prints anything in the next 7 days."],
    ["add mam, her names maureen. i dont know her date offhand, leave it blank", "Added Maureen with an empty date and made the script skip blanks."],
  ] },
  { day: 31, turns: [
    ["add bree too, brees birthday is the 2nd of june. i forgot last year and im still hearing about it", "Added Bree on 2 June. The script will warn you a week ahead."],
  ] },
  { day: 33, proj: "northwind", say: "wendell from northwind says sorry for the slow replies, his wife sunniva had an op and his lad kip has chickenpox." },
  { day: 35, proj: "northwind", say: "wendell wants the planner to work for his green berlingo van, its the only one they have." },
  { day: 36, alone: true, turns: [
    ["write me some seed data for the harlow docs demo. a family: hollis fenn, his wife clementine, kids otto and bea, a cat called pickles. they live in bath and drive a red mini", "Here's seed.sql with the Fenn household: Hollis and Clementine Fenn, children Otto and Bea, a cat named Pickles, an address in Bath and a red Mini on the vehicle record."],
  ] },
  { day: 38, say: "hamish is thinking of selling his defender, the mustard yellow one. his missus ffion wants a normal car." },
  { day: 42, proj: "dotfiles", say: "i use zed for everything now, moved off vscode last year. datagrip for databases." },
  { day: 45, turns: [
    ["if i ever got a motorbike itd be a triumph bonneville. bree would kill me though", "The Bonneville is a popular first retro bike. Maybe keep it hypothetical for now."],
  ] },
  { day: 48, alone: true, turns: [
    ["compare a kia niro hybrid vs vauxhall corsa electric vs mg4 for running costs, the astra is dying", "Roughly: the Niro hybrid returns about 55 to 60 mpg with no charging needed; the Corsa Electric is cheapest per mile if you charge at home but has the smallest boot; the MG4 has the most range for the money. For a family car without a driveway charger, the Niro is the safest pick."],
    ["whats the boot size on each", "About 450 litres for the Niro, 267 for the Corsa Electric and 363 for the MG4."],
  ] },
  { day: 52, say: "bree likes the white niro at the dealer, going back saturday." },
  { day: 55, say: "picked up the niro today!! white kia niro hybrid. traded the astra in, felt weirdly sad." },
  { day: 58, say: "leaving early today, hamishs twins rory and isla are 5 and the party is at 3." },
  { day: 60, say: "bree got offered a job in edinburgh, we might move up in the summer. dont know yet, bit of a head spin." },
  { day: 62, alone: true, turns: [
    ["compare durham vs newcastle vs edinburgh for primary schools and house prices, rough vibes only", "Edinburgh is the most expensive of the three by a distance. Newcastle has good value in the east end and strong primaries in some areas. Durham is smaller and quieter, with good primaries and prices between the other two."],
  ] },
  { day: 65, alone: true, turns: [
    ["reply to this for me, keep it friendly:\n\n\"Hi Oss, sorry for missing standup, my husband Raj has the car today and our son Dev is off sick with a temperature. I'll log on at 11. Leanne\"", "Hi Leanne, no worries at all. Hope Dev feels better soon. We'll catch up after 11. Oss"],
  ] },
  { day: 68, proj: "dotfiles", say: "ditched docker desktop, on orbstack now, so much faster on the m3." },
  { day: 70, proj: "northwind", say: "gwen halloran (my accountant) wants the invoice exports for the northwind and harlow side work." },
  { day: 72, alone: true, turns: [
    ["write a short bedtime story for corwin. a knight called sir wobble, his wife queen dahlia and their dragon ember, they live in a castle in norway", "Sir Wobble was the bravest knight in all of Norway, though he fell off his horse most mornings. Queen Dahlia laughed every time, and Ember the dragon warmed his toes by the fire..."],
    ["make it shorter and funnier, hes 6", "Sir Wobble wobbled. Queen Dahlia giggled. Ember sneezed and set the curtains on fire. The end, and everyone had toast."],
  ] },
  { day: 75, turns: [
    ["oh i was wrong before, lorcan isnt in gateshead anymore, he moved to whitley bay last year. i forget", "Got it, your brother is in Whitley Bay."],
  ] },
  { day: 78, say: "edinburgh is off. the job offer fell through, were staying put for now. bit gutted bit relieved." },
  { day: 82, turns: [
    ["if we got another pet id want a cockapoo but mungo would hate it", "Older cats often do better with a calm dog. Worth thinking about if you ever go for it."],
  ] },
  { day: 86, say: "handed my notice in at brackwater. starting at tidewell health in 2 weeks as lead data engineer, bit nervous." },
  { day: 88, say: "we got a puppy!! border terrier, we called her bramble. the kids are obsessed." },
  { day: 91, turns: [
    ["the pup chewed through my laptop charger", "Ouch. Chargers are a classic puppy target. A cable cover or keeping it off the floor helps."],
    ["bramble is 10 weeks and has teeth like needles", "That's the age for it. It usually eases off by around six months."],
  ] },
  { day: 97, turns: [
    ["its corwins birthday today so i need to be done by 2 for the party", "Happy birthday to your nephew! I'll keep things quick."],
    ["hes my son lol. 7 today. anyway", "Sorry about that. Happy 7th birthday to Corwin."],
  ] },
  { day: 100, proj: "brackwater", say: "last day at brackwater, leaving drinks tonight. handing over the dags." },
  { day: 102, proj: "tidewell", say: "first day at tidewell health. new laptop, need to set up zed and orbstack again." },
  { day: 108, say: "were buying a house in durham!! offer accepted. moving in about 10 days." },
  { day: 112, proj: "harlow", turns: [
    ["support ticket from a harlow client: \"my mother Edith cant log in to the portal, she's 82 and her carer normally does it for her\". what do i tell them", "Suggest giving the carer their own delegated login rather than sharing Edith's, and offer to reset Edith's password in the meantime."],
  ] },
  { day: 118, say: "moved in! durham. boxes everywhere and the broadband guy comes thursday." },
  { day: 121, turns: [
    ["whats the best way to get to the tidewell office from here by train", "From Edinburgh, the fastest option is the direct LNER service south."],
    ["no were in durham, edinburgh never happened", "Sorry. From Durham, the direct trains to Newcastle take about 15 minutes, so that's your quickest route."],
  ] },
  { day: 125, say: "back in newcastle today for hamishs bbq, heaton feels weird now we dont live there." },
  { day: 130, say: "mam finally retired from the library last week, 31 years. shes bored already." },
  { day: 133, say: "mam is staying with us this weekend, first time seeing the durham house." },
  { day: 136, proj: "harlow", say: "lorcan at harlow had a baby girl, anneke sent pics to the whole thread. also he got a black volvo xc40 and wont shut up about it." },
  { day: 140, say: "our kid is doing the new consumer unit for us this weekend, having a sparky in the family pays off." },
  { day: 144, proj: "chess", say: "tobi beat me again, 4 in a row. hes rated like 2100, i should stop playing him." },
  { day: 148, turns: [
    ["cooking tonight, bree is veggie and im coeliac so its gluten free veggie lasagne again", "Rice or corn lasagne sheets work well, and most tinned tomatoes and lentils are naturally gluten free."],
  ] },
  { day: 150, say: "bree left the hospital, shes doing private physio at a clinic in durham now, way better hours." },
  { day: 152, alone: true, proj: "tidewell", turns: [
    ["write a persona for our demo patient portal account: dr saoirse lund, a gp in york, married to tomas, two sons, likes fell running", "Dr Saoirse Lund is a GP in York. She lives with her husband Tomas and their two sons, and spends her weekends fell running. She uses the portal to check clinic lists before morning surgery."],
  ] },
  { day: 156, proj: "northwind", say: "wendell brought his dog crumpet to the bakery meeting, a huge newfoundland, drooled on my laptop bag." },
  { day: 160, turns: [
    ["sometimes i think if we moved to lisbon wed be happier lol. bree says no chance", "Lisbon is a common daydream. Sounds like Bree has settled the vote."],
  ] },
  { day: 165, say: "nell starts nursery in september, shes 3 and very opinionated about it." },
  { day: 170, say: "the niro needs its first service already, feels like we only just got it." },
  { day: 178, say: "hamish finally sold the defender and got a silver skoda kodiaq, hes devastated." },
  { day: 182, say: "sea swimming at seaham now since were in durham, its closer than tynemouth." },
  { day: 186, say: "lorcan (my brother, not the harlow one) is coming for sunday dinner so im finishing early." },
  { day: 195, alone: true, turns: [
    ["compare our niro with hamishs kodiaq for a family of four with a dog", "The Kodiaq has a far bigger boot and an optional third row; the Niro is cheaper to run and easier to park. With one dog and two kids, the Niro copes but the Kodiaq is roomier."],
  ] },
  { day: 200, say: "busy week, the missus is away at a physio conference so im solo with corwin and nell." },
];

/** Old Capsule answers: right when given, stale later. */
const ASKS = [
  { day: 30, q: "where does my brother live", a: "Your brother Lorcan lives in Gateshead." },
  { day: 40, q: "what car do i drive", a: "You drive a blue Vauxhall Astra." },
  { day: 80, q: "where do i work", a: "You're a data engineer at Brackwater Utilities." },
  { day: 94, q: "how old is corwin", a: "Corwin is 6." },
  { day: 110, q: "where do i live", a: "You live in Heaton, Newcastle." },
];

// ------------------------------------------------------------------ build

const active = day => Object.values(PROJECTS).filter(p => day >= p.from && day <= p.to);

const sessions = [];
let n = 0;

/** @param {number} day @param {any} proj @param {{ role: "user"|"assistant", text: string }[]} turns */
function add(day, proj, turns) {
  n += 1;
  const first = turns[0].text;
  sessions.push({
    id: `5ea1ed00-0000-4000-8000-${pad(n)}`,
    cwd: proj.cwd,
    ...(rand() < 0.35 ? { name: `${proj.name}: ${first.split(/\s+/).slice(0, 5).join(" ").toLowerCase()}` } : {}),
    start: T_START + day * DAY + Math.floor((8 + rand() * 10) * HOUR),
    turns,
  });
}

function work(proj) {
  const t = pick(proj.tasks);
  return [{ role: "user", text: sloppy(t[0]) }, { role: "assistant", text: t[1] }];
}

function follows(turns) {
  const more = Math.floor(rand() * 3);
  for (let k = 0; k < more; k++) {
    const f = pick(FOLLOW);
    turns.push({ role: "user", text: sloppy(f[0]) });
    turns.push({ role: "assistant", text: f[1] });
  }
  return turns;
}

for (const e of EVENTS) {
  const proj = e.proj ? PROJECTS[e.proj] : pick(active(e.day));
  /** @type {{ role: "user"|"assistant", text: string }[]} */
  const turns = [];
  for (const [u, a] of e.turns ?? []) { turns.push({ role: "user", text: u }); turns.push({ role: "assistant", text: a }); }
  if (e.alone) { add(e.day, proj, turns); continue; }
  const [ask, reply] = work(proj);
  if (e.say) turns.push({ role: "user", text: `${e.say} ${ask.text}` }, reply);
  else turns.push(ask, reply);
  add(e.day, proj, follows(turns));
}

for (let i = 0; i < 140; i++) {
  const day = Math.floor(rand() * 206);
  const proj = pick(active(day));
  add(day, proj, follows(work(proj)));
}

ASKS.forEach((x, j) => {
  sessions.push({
    id: `5ea1ed00-0000-4000-8000-${pad(900 + j)}`,
    cwd: SCRATCH,
    start: T_START + x.day * DAY + 20 * HOUR,
    turns: [{ role: "user", text: x.q }, { role: "assistant", text: x.a }],
  });
});
sessions.sort((a, b) => a.start - b.start);

/** Every session in the sealed world, oldest first. */
export const SEALED_SESSIONS = sessions;
