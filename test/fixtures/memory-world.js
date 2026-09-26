// @ts-check
// The world Memory's evaluation runs against (docs/adr/0007-intelligence.md, decision 5). It is
// the shared fictional corpus (test/fixtures/corpus.js, untouched) plus sessions written to trip
// the curator: a second Dana Reyes at another firm, two different "Summit"s in two projects,
// titles, a client, deadlines, a preference, a decision, code talk that sounds like facts,
// sessions eight months old, and a planning thread picked into two projects.
//
// Everyone and everything here is invented. Alex Rivera runs Rivera Studio (config.me).
//
// Rooms (decision 1): each project is its folders plus the threads picked into it; a session in
// no project is in "unfiled". The gold file (test/eval/memory-gold.json) names rooms as
// "project:<slug>", "unfiled", or "*" for the main graph.

import { SESSIONS, HOME } from "./corpus.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;
/** Eight months before the corpus: facts that should read as stale. */
const OLD = Date.parse("2026-01-20T10:00:00Z");
/** The clock the evaluation reads, so ages and decay do not drift with the calendar. */
export const NOW = Date.parse("2026-09-26T12:00:00Z");

export const ME = { name: "Alex Rivera", domains: ["riverastudio.com"], emails: ["alex@riverastudio.com"] };

let n = 0;
/**
 * A session. Strings alternate user, assistant, starting with the user.
 * @param {string} dir  folder under ~/Work ("" for ~/Work itself)
 * @param {number} start
 * @param {string[]} turns
 * @param {string} [name]
 * @returns {import("./corpus.js").Session}
 */
const S = (dir, start, turns, name) => ({
  id: `33333333-cccc-4000-8000-${String(++n).padStart(12, "0")}`,
  cwd: dir ? `${HOME}/Work/${dir}` : `${HOME}/Work`,
  ...(name ? { name } : {}),
  start,
  turns: turns.map((text, i) => ({ role: /** @type {"user"|"assistant"} */ (i % 2 ? "assistant" : "user"), text })),
});

// ------------------------------------------------------------------ Harlow Legal (project harlow)

const HARLOW = [
  S("harlow-site", T0 + 2 * DAY, [
    "Dana Reyes, the office manager at Harlow Legal, signed off on the new homepage. The Harlow launch is due 18 September.",
    "Noted. I planned the Harlow launch for 18 September and kept the intake form above the fold on harlowlegal.com.",
  ], "Harlow launch plan"),
  S("harlow-intake", T0 + 3 * DAY, [
    "We decided to keep intake on one page. Dana Reyes asked for no second step.",
    "Kept it on one page; the Harlow intake form now submits in a single step.",
  ], "Intake form scope"),
  S("harlow-site", T0 + 5 * DAY, [
    "Harlow Legal is reviewing a lease for Summit Dental. Put the Summit Dental logo from summitdental.com on the client stories page.",
    "Added the Summit Dental logo to the Harlow client stories page, linked to summitdental.com.",
  ]),
  S("harlow-intake", T0 + 6 * DAY, [
    "Summit Dental sent a second testimonial through the Harlow intake form. Check it came from info@summitdental.com.",
    "It did: info@summitdental.com, filed under Summit Dental in the Harlow intake log.",
  ]),
  // Code talk. Nothing here is a client, a deadline or a preference.
  S("harlow-site", T0 + 7 * DAY, [
    "The API client in src/lib/http.ts retries twice by default. Make the HTTP client time out after 5 seconds, then ship it Friday.",
    "Set the HTTP client timeout to 5 seconds; the API client still retries twice by default. Ready to ship it Friday.",
  ]),
  // Eight months old: someone who worked there then, never mentioned since.
  S("harlow-site", OLD, [
    "Marcus Bell at Harlow Legal handled the old site. Marcus Bell (marcus@harlowlegal.com) sent the logo files.",
    "Saved the logo files Marcus Bell sent into assets/brand.",
  ], "Old Harlow logo"),
  S("harlow-site", OLD + 2 * DAY, [
    "Marcus Bell wants the old blog archived before the redesign.",
    "Archived the old blog for Marcus Bell under /archive.",
  ]),
];

// ------------------------------------------------------------------ Northwind Bakery (project northwind)

const NORTHWIND = [
  S("northwind", T0 + 2 * DAY, [
    "Sam prefers invoices as PDF. Sam Okafor (sam@northwindbakery.com) says the spreadsheet ones get lost.",
    "Switched the watcher to attach each invoice as a PDF for Sam Okafor at Northwind Bakery.",
  ], "Invoice format"),
  S("northwind", T0 + 4 * DAY, [
    "Northwind Bakery is a new client, so add them to the studio's client list and set up analytics on northwindbakery.com.",
    "Added Northwind Bakery to the client list and put analytics on northwindbakery.com.",
  ]),
  S("northwind", T0 + 8 * DAY, [
    "Lena Park, the head baker at Northwind Bakery, wants the menu page updated. Send the draft to Lena Park (lena@northwindbakery.com).",
    "Updated the menu page and sent Lena Park (lena@northwindbakery.com) the preview.",
  ], "Menu page"),
  S("northwind", T0 + 9 * DAY, [
    "Lena Park checked the new menu page and wants the prices in bold.",
    "Prices on the Northwind Bakery menu page are bold now, as Lena Park asked.",
  ]),
  S("northwind", T0 + 11 * DAY, [
    "Write a regex that matches ISO dates in the invoice filenames.",
    "Done: /\\d{4}-\\d{2}-\\d{2}/ now matches every date in the invoice filenames.",
  ]),
];

// ------------------------------------------------------------------ Keel & Ash Architects (project keel-ash)

const KEEL = [
  S("keel-ash", T0 + 1 * DAY, [
    "Keel & Ash Architects are our new client and want a portfolio site. Priya Anand, the studio director at Keel & Ash Architects, sent the brief from p.anand@keelash.studio.",
    "Started the Keel & Ash portfolio site in github.com/keelash/portfolio-site; it will deploy to keelash.studio.",
  ], "Keel & Ash kickoff"),
  S("keel-ash", T0 + 3 * DAY, [
    "Priya Anand wants the project gallery before the hero. Keel & Ash Architects will send photos to Priya Anand (p.anand@keelash.studio) first.",
    "Moved the gallery above the hero on keelash.studio and pushed it to github.com/keelash/portfolio-site.",
  ]),
  S("keel-ash", T0 + 6 * DAY, [
    "Summit Roofing is doing the roof on the Keel & Ash library job. Omar Haddad at Summit Roofing (omar@summitroofing.com) wants a credit on the site.",
    "Credited Summit Roofing on the library project page, linked to summitroofing.com.",
  ]),
  S("keel-ash", T0 + 8 * DAY, [
    "Add a Summit Roofing case study. Omar Haddad (omar@summitroofing.com) sent the photos.",
    "Drafted the Summit Roofing case study with the photos Omar Haddad sent.",
  ], "Summit Roofing case study"),
  S("keel-ash", T0 + 10 * DAY, [
    "Keel & Ash Architects launches on 2 October, so the gallery must be finished by then.",
    "Understood: everything on keelash.studio is scheduled to be finished before 2 October.",
  ]),
];

// ------------------------------------------------------------------ unfiled: in no project

const UNFILED = [
  // A different Dana Reyes, at a different firm.
  S("bramble-dental", T0 + 4 * DAY, [
    "Dana Reyes at Bramble Dental (dana@brambledental.com) wants the booking widget fixed.",
    "Fixed the booking widget on brambledental.com for Dana Reyes.",
  ], "Bramble booking widget"),
  S("bramble-dental", T0 + 9 * DAY, [
    "Dana Reyes from Bramble Dental says the widget works now and asked for a reminder email too.",
    "Added a reminder email sent from brambledental.com the day before each booking.",
  ]),
  // Eight months old and never said since: only where it came up.
  S("millbrook", OLD + 1 * DAY, [
    "The new menu for Millbrook Cafe needs a holiday section.",
    "Added a holiday section to the Millbrook Cafe menu.",
  ]),
  S("millbrook", OLD + 3 * DAY, [
    "Millbrook Cafe approved the holiday menu, send the final files.",
    "Sent the final Millbrook Cafe menu files.",
  ]),
  // More code talk, in no project.
  S("tools", T0 + 12 * DAY, [
    "Refactor the HTTP client to use fetch, keep the API client as it is by default, and we ship it Friday.",
    "Moved the HTTP client to fetch; the API client is unchanged and the branch is ready to ship it Friday.",
  ]),
];

// ------------------------------------------------------------------ the hub thread, picked into two projects

const WEEKLY = S("", T0 + 7 * DAY, [
  "Weekly planning: the Harlow launch is due 18 September, Northwind Bakery needs PDF invoices, and Sam Okafor asked whether Dana Reyes can join the Harlow launch call.",
  "This week: finish the Harlow Legal site for 18 September, switch Northwind Bakery to PDF invoices for Sam Okafor, and invite Sam to the Harlow call with Dana Reyes.",
], "Weekly planning");

/** The shared corpus's own planning thread ("Weekly planning", in ~/Work). */
const FIRST_WEEKLY = SESSIONS.find(s => s.name === "Weekly planning")?.id || "";

/** Every session the evaluation seeds: the shared corpus as it is, then this world's. */
export const EVAL_SESSIONS = [...SESSIONS, ...HARLOW, ...NORTHWIND, ...KEEL, ...UNFILED, WEEKLY];

/**
 * Projects, in the shape projects.list returns them: threads and picked are counts, picks the
 * ids of the threads picked into each (only picks are read; threads here counts the picks). Both
 * planning threads are picked into Harlow and Northwind: a room must not learn another client
 * from them (decision 1, the anchor rule).
 */
export const PROJECTS = [
  { slug: "harlow", name: "Harlow Legal", org: "Harlow Legal", home: `${HOME}/Work/harlow-site`, workspaces: [`${HOME}/Work/harlow-intake`], threads: 2, picked: 2, picks: [FIRST_WEEKLY, WEEKLY.id] },
  { slug: "northwind", name: "Northwind Bakery", org: "Northwind Bakery", home: `${HOME}/Work/northwind`, workspaces: [], threads: 2, picked: 2, picks: [FIRST_WEEKLY, WEEKLY.id] },
  { slug: "keel-ash", name: "Keel & Ash Architects", org: "Keel & Ash Architects", home: `${HOME}/Work/keel-ash`, workspaces: [], threads: 0, picked: 0, picks: [] },
];

/** A project's folders: its home and workspaces. */
export const foldersOf = p => [p.home, ...(p.workspaces || [])];
