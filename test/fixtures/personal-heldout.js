// @ts-check
// A held-out world for memory.answer (team/archive/work-journals/memory-iq.md). personal-world.js was written by
// the same hands that wrote the rules, so a perfect score on it proves little. This one was
// written before reading the rules, in the way a real person types to a coding assistant:
// lowercase, typos, run-on asides, nicknames ("hubby", "the mazda", "robin's bday"), and the
// facts buried in design and front-end work, pasted client emails, other people's families,
// hypotheticals, earlier questions and the assistant's own turns.
//
// Everyone and everything here is invented. Juno Hale is a freelance designer; the clients are
// Harlow Legal (Owen Price) and Northwind Bakery (Bea Lindqvist). Nothing real may be added.
//
// Deterministic: a seeded generator, no clock. Same shape as personal-world.js, so
// scripts/eval-answer.js runs it with `--world heldout`.
//
// The truth (what test/eval/answer-heldout.json asks about):
//   husband Robin ("my partner", "hubby", "robin and i"), birthday 2 June
//   kids Theo (son) and Isla (daughter), father Graham, cat Pepper
//   a grey Honda Civic, sold on day 82; a red Mazda CX-5, bought on day 79
//   lived in Bristol, moved to Leeds on day 104 (the newest place must win)
//   a freelance designer, clients Harlow Legal and Northwind Bakery; uses Figma and Obsidian
// Never said: a wife, a dog, a mother's name, a sister, a brother, a bank, where Juno was born,
// a gym, which phone, a dentist, a favourite restaurant, a blood type.
// Traps: Owen's wife Claire and son Max, Bea's partner Tom, a design persona called Graham, a
// friend's Tesla, a puppy that was only talked about, Theo born in Bristol, and an old Capsule
// answer that still says Bristol.

export const HOME = "/home/juno";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The first day of the timeline. */
export const T_START = Date.parse("2026-01-05T08:30:00Z");
/** The clock the evaluation reads: a few days after the last session. */
export const NOW = T_START + 200 * DAY;
/** Who the user is (config.me). */
export const ME = { name: "Juno Hale", domains: ["junohale.design"], emails: ["juno@junohale.design"] };
/** The Capsule's ask folder under the world's vyred home: its threads are the Capsule's own. */
export const SCRATCH = `${HOME}/.vyre/capsule/ask`;

/** Days on which life changed. */
export const TIMELINE = { mazdaBought: 79, civicSold: 82, movedToLeeds: 104, robinBirthday: 148 };

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

// ------------------------------------------------------------------ the work (the bulk)

const PROJECTS = [
  { dir: "clients/harlow-legal/site", label: "harlow site", files: ["hero", "services", "team", "contact-form", "footer"], parts: ["nav", "cta button", "testimonial card"] },
  { dir: "clients/northwind/ordering", label: "northwind orders", files: ["menu", "basket", "checkout", "opening-hours"], parts: ["product tile", "price tag", "allergen badge"] },
  { dir: "portfolio", label: "portfolio", files: ["index", "case-study", "about", "og-image"], parts: ["project grid", "header", "contact link"] },
  { dir: "tools/figma-tokens", label: "tokens script", files: ["export", "colors", "type-scale", "spacing"], parts: ["color ramp", "font sizes", "radius"] },
  { dir: "notes/obsidian-publish", label: "notes sync", files: ["sync", "frontmatter", "backlinks"], parts: ["daily note", "tag index"] },
];

/** Work requests and replies. {f} a file, {x} a component, {p} the project, {n} a number. */
const DEV = [
  ["the {x} on mobile is overflowing, can u fix the css in {f}.tsx", "The {x} had a fixed width of {n}px. I switched it to max-width: 100% and added a flex-wrap, so it no longer overflows below 380px."],
  ["make the {x} match figma, its 2px off everywhere", "I matched the padding and the line height to the Figma frame: 16px padding and a 1.4 line height. The 2px drift came from a border that Figma draws inside and CSS draws outside."],
  ["can you export the colours from figma into css vars", "Done. src/styles/tokens.css now has {n} custom properties generated from the Figma variables, grouped by ramp."],
  ["why does {f} look blurry on retina", "The image is served at 1x. I added a srcset with 2x and 3x versions and set sizes, so retina screens load the sharp one."],
  ["add a dark mode to the {p}, just the basics", "I added a prefers-color-scheme block that swaps the surface and text tokens. The {x} keeps enough contrast in both themes."],
  ["lighthouse says CLS is bad on {f}, whats causing it", "The web font swaps late and the hero image has no dimensions. I set width and height on the image and added font-display: optional. CLS dropped to 0.02."],
  ["write alt text for the images on the {f} page", "I wrote alt text for {n} images, describing what each shows rather than repeating the caption."],
  ["the contact form in {f} submits twice sometimes??", "The button had both an onClick and the form's onSubmit. I removed the onClick and disabled the button while the request is in flight."],
  ["rename the {x} component to something less vague", "Renamed it and updated the {n} imports. Tests and the type check pass."],
  ["can u make the {x} animate in, subtle, like 200ms", "Added a 200ms opacity and translate transition, and it respects prefers-reduced-motion."],
  ["the fonts arent loading on prod but fine locally", "The font path was relative to the page, so nested routes asked for the wrong URL. I made it absolute from the site root."],
  ["pls tidy up {f}.tsx its a mess", "I split {f}.tsx into three smaller components and removed two unused props. Nothing visible changed."],
  ["add basic seo tags to the {p}", "Added a title, a description, canonical URLs and Open Graph tags per page. The OG image uses the {x} style."],
  ["the {x} colour fails contrast apparently", "The text was 3.1:1 against the background. I darkened it one step on the ramp; it is now 4.8:1 and passes AA."],
  ["can you write a quick node script to resize all pngs in /assets to 1600 wide", "Wrote scripts/resize.mjs using sharp. It resized {n} images and skipped the ones already narrower than 1600px."],
  ["why is the build {n}kb bigger than last week", "A date library came in with the new {x}. I replaced it with Intl.DateTimeFormat and the bundle is back under the old size."],
  ["make the {f} page print nicely", "Added a print stylesheet that hides the nav, expands links to show their URLs and keeps the {x} on one page."],
  ["frontmatter in {f}.md keeps breaking the sync", "Some notes use tabs in the YAML. The parser now normalises tabs to spaces before reading the frontmatter."],
  ["hook the {x} up to the cms field instead of hardcoding", "The {x} now reads from the CMS entry and falls back to the old text if the field is empty."],
  ["can you check the {p} for broken links", "I crawled {n} pages and found 3 broken links, all to an old /services path. I added redirects for them."],
  ["this grid breaks at exactly 768px lol", "Two media queries both matched at 768px. I made the tablet range min-width 768px and the phone range max-width 767px."],
  ["add a skip to content link", "Added a visually hidden skip link that appears on focus and jumps to main."],
  ["squash the svg icons, theyre huge", "Ran the {n} icons through svgo with the default preset. Total size went down by about 60 percent."],
  ["the date on the {x} shows in american format, i want uk", "Switched the formatter to en-GB, so it now reads day, month, year."],
  ["write a changelog entry for todays {p} changes", "Added an entry for today covering the {x} fix, the new tokens and the redirects."],
  ["add a loading state to the {x}", "The {x} now shows a skeleton while the data loads, sized to match the real content so nothing jumps."],
  ["how do i make {f} a server component again", "Move the useState into a small client child and keep {f} itself free of hooks; then it renders on the server."],
  ["ok and deploy the {p} preview", "Pushed a preview build. It passed the checks and the preview URL is in the PR."],
];

// ------------------------------------------------------------------ the life, in passing

/**
 * The asides that carry the facts. `from`/`to` bound the days a line can appear on; `n` repeats
 * it in that many sessions; `a` is the assistant's reply when it has one of its own.
 * @type {{ u: string, a?: string, from?: number, to?: number, n?: number }[]}
 */
const ASIDES = [
  // Robin, the husband, by every name but the formal one.
  { u: "hubby's cooking tonight so i can push through this", n: 2 },
  { u: "robin and i are off to york for the weekend so i need this done by fri", a: "Understood. I'll keep the changes small so they can ship by Friday." },
  { u: "my partner robin says the logo looks too corporate, thoughts?", a: "He has a point: the heavy serif and navy read as formal. A lighter weight would soften it." },
  { u: "robin's picking up the kids so i've got an extra hour", n: 2 },
  { u: "my husband thinks i should put my day rate up tbh" },
  { u: "gonna be afk for a bit, robin locked himself out lol" },
  { u: "robin and i had a debate about whether the button should be green, he lost" },
  { u: "need a gift idea for my husband, his birthday's the 2nd of june. he likes cycling and old maps", a: "A framed antique map of a route he has ridden would suit both. A cycling cap from a small maker is a cheaper option.", from: 110, to: 140 },
  { u: "remind me robin's bday is 2 june, i always leave it to the last minute", from: 120, to: 145 },
  { u: "it's robin's birthday today so logging off early, the kids made a cake", from: 146, to: 151 },
  { u: "partner's away for work til thurs so it's just me and the kids", n: 2 },
  // The kids.
  { u: "school run with theo then i'm back", n: 3 },
  { u: "isla's got a temperature so i'm home with her today, might be slow", n: 2 },
  { u: "theo (he's 9) wants to learn to code, is scratch still the thing for kids?", a: "Scratch is still a good start at 9. After that, a Python turtle project works well." },
  { u: "my daughter isla drew pepper all over my sketchbook lol" },
  { u: "my son theo snapped my apple pencil. the second one this year" },
  { u: "isla's our youngest and she's decided she's a designer too, she wants her own figma" },
  { u: "theo has football at 5 so hard stop at 4:30" , n: 2 },
  { u: "the kids start at the new school on monday, bit nervous for them", from: 104, to: 112 },
  // Dad.
  { u: "dad (Graham) is visiting next week so i'll be offline thurs/fri", from: 30, to: 60 },
  { u: "my dad's here, he's taking theo and isla to the museum so i've got the afternoon", from: 30, to: 62 },
  { u: "graham (my dad) wants me to make him a website for his allotment club lol. free labour", from: 120, to: 190 },
  // Pepper, the cat.
  { u: "sorry pepper just walked across the keyboard", n: 3 },
  { u: "our cat pepper is at the vet this morning so i'm a bit distracted" },
  { u: "pepper hates the new house, she's been under the bed for 3 days", from: 105, to: 120 },
  // The cars.
  { u: "the civic's in for its MOT so i'm working from the cafe today", to: 70 },
  { u: "gotta leave in 10, the honda is making that grinding noise again", to: 75, n: 2 },
  { u: "our grey civic failed the mot lol, advisories on the brakes and a tyre", to: 76 },
  { u: "just picked up the new car!! red mazda cx-5, bye bye civic", from: 79, to: 82 },
  { u: "sold the honda to a guy from swindon today, weirdly sad", from: 82, to: 85 },
  { u: "loading theo's football kit into the mazda brb", from: 85, n: 2 },
  { u: "the mazda needs its first service already?? only had it a few months", from: 160 },
  { u: "parked the cx5 at the station so i'm on the laptop on the train", from: 90 },
  // Where they live.
  { u: "it's pouring in bristol again, perfect day for pixel pushing", to: 100, n: 2 },
  { u: "we're viewing houses in leeds this weekend, robin's job is moving up there", from: 60, to: 95 },
  { u: "packing boxes all week, the move from bristol is friday", from: 96, to: 104 },
  { u: "still getting used to leeds, everything is 10 mins further than i think", from: 106 },
  { u: "the wifi in the new place in leeds is awful so i'm tethering, bear with me", from: 104, to: 130 },
  { u: "found a nice co-working spot in leeds city centre, might go twice a week", from: 115 },
  // Work.
  { u: "for context im a freelance designer, mostly figma but i do a bit of front end", a: "Got it. I'll keep the CSS readable and match your Figma naming." },
  { u: "harlow legal want another round on the homepage, third time", n: 2 },
  { u: "owen from harlow legal emailed again about the team photos" },
  { u: "bea at northwind bakery wants the new menu pdf by friday" },
  { u: "my two clients right now are harlow legal and northwind bakery, both want stuff this week" },
  { u: "i keep all my notes in obsidian, can you give me a template for client meeting notes", a: "Here is a template with date, attendees, decisions and actions as frontmatter, and a section for open questions." },
  { u: "exporting the frames from figma now, give me a sec", n: 2 },
];

// ------------------------------------------------------------------ the noise

/** A pasted email from a client: someone else's family, full of the same words. */
const EMAIL = [
  "can you help me reply to this from owen:\n\n\"Hi Juno, thanks for the new homepage. My wife Claire and I are away from the 12th so our son Max will be dropping the signed contract in. Could the team page go live before then? Also my car (the new BMW) is in the photos by accident, can we crop it. Best, Owen Price, Harlow Legal\"",
  "Here is a reply: \"Hi Owen, thanks, glad you like it. The team page can go live on the 10th, before you leave. I'll crop the car out of the photos. Best, Juno\"",
  "make it a bit warmer, he's nice",
  "\"Hi Owen, thank you, that's lovely to hear. I'll have the team page live on the 10th so it's up before you and Claire head off, and I'll crop the car out. Have a great trip. Best, Juno\"",
];

/** A client's family law page: every family word, none about the user. */
const FAMILY_PAGE = [
  "writing copy for harlow's family law page. draft: 'Separating from your husband or wife is hard. We help you and your children through it.' make it less stiff",
  "\"Ending a marriage is one of the hardest things you'll do. We'll help you, your partner and your children find a way through that works for everyone.\"",
  "add a line about grandparents, like a dad or mum wanting access to the grandkids",
  "\"Grandparents matter too. If you're a mum or dad hoping to stay close to your grandchildren, we can help.\"",
  "and one about pets lol, people fight over the dog apparently",
  "\"Even the family dog. We help you agree on the things that matter to you, down to who walks the dog.\"",
];

/** A design persona: a name the user never uses for anyone in their life. */
const PERSONA = [
  "write me a user persona for harlow legal's wills service",
  "Persona: Graham, 67, a retired teacher in Harrogate. Wants a simple will after his wife passed. Reads on a tablet, distrusts jargon, wants a phone number he can call.",
  "good, add a second one, younger",
  "Persona: Priya, 34, a nurse with two young children and a mortgage. Wants a will and guardianship sorted before a work trip. Books online in the evening.",
];

/** Friends and clients: other people's lives. */
const OTHERS = [
  "my friend sophie's husband dev keeps telling me to learn rust, he's got a tesla and won't shut up about it",
  "Rust is a big step from front end. If you want something close to your work, TypeScript types or a small Svelte project would pay off sooner.",
  "bea's partner tom runs the other northwind shop, can the site show both addresses",
  "Yes. I added a locations block that lists both shops with their own opening hours, and the map pin switches between them.",
];

/** Hypotheticals: things that were never true. */
const MAYBE = [
  "if we got a dog what breed is ok with kids and a cat? robin says no but i'm working on him",
  "With a cat at home, a calm breed raised with cats is best. A cavalier or a whippet usually does well with children and cats.",
  "what would a tesla model 3 cost to run vs a petrol car, just curious, not buying one",
  "Roughly a third of the fuel cost per mile if you charge at home, less if you have an off-peak tariff. Insurance tends to be higher.",
  "compare the mazda cx-5 and the kia sportage for a family of four",
  "Both fit two kids and a dog crate. The CX-5 drives better and feels more premium; the Sportage has more boot space and a longer warranty.",
];

/** Theo's birth, which is not where the user was born. */
const BORN = [
  "theo was born in bristol so he's gutted about leaving, any ideas to make the move easier for a 9 year old",
  "Let him help plan his new room, keep a video call slot with his old friends, and find a football club in Leeds before the first week.",
];

/** Monthly invoice sessions: money words, no bank. */
const INVOICE = [
  "make an invoice template, uk, vat registered no",
  "Here is a clean invoice with your details, the client, line items, a total and payment terms of 14 days. No VAT line, since you're not registered.",
  "add the bank details section but leave it blank, i'll fill it",
  "Added an empty payment details block with labels for account name, sort code and account number.",
];

/** Earlier questions to the Capsule, with the answers it gave at the time. One of them is stale. */
const ASKED = [
  ["whats my husband's name?", "Robin."],
  ["where do i live", "Bristol."],
  ["when is robin's birthday", "2 June."],
  ["what's the cat called", "Pepper."],
];

/** Home errands: household admin, some of it about the family. */
const HOME_TASKS = [
  ["make me a spreadsheet for the school holidays so robin and i can split the days", "Here is a sheet with each week of the holidays, a column for each of you and a row for childcare swaps."],
  ["meal plan for the week, theo won't eat anything green", "Here are seven dinners with the greens blended into sauces, plus a list for the shop."],
  ["write a note to the school, isla will be off for a dentist appointment tuesday morning", "\"Dear Mrs Holt, Isla will be late on Tuesday because of a dental appointment. She'll be in by 11. Thanks, Juno Hale\""],
  ["what's a good way to keep track of the car insurance renewal and stuff", "A recurring note in Obsidian with the renewal dates and a reminder a month ahead works well."],
  ["budget spreadsheet, household, monthly", "Here is a monthly budget with income, fixed bills, food, the car, the kids' clubs and savings."],
  ["how do i get cat hair off a wool coat", "A rubber glove or a damp sponge lifts it better than a lint roller. Brush in one direction."],
  ["draft a whatsapp to the football parents about lift sharing", "\"Hi all, would anyone like to share lifts to Saturday football? I can do the first two weeks.\""],
  ["plan a rainy day for two kids, 9 and 6", "A den in the living room, a baking hour, and a Scratch game for the older one to build with the younger one."],
  ["convert this recipe to grams pls, 2 cups flour 1 cup sugar", "About 250 g of flour and 200 g of sugar."],
  ["what should be on a moving house checklist", "Redirect post, change the address on the car and insurance, register with a new GP and school, and read the meters on the day."],
];

// ------------------------------------------------------------------ the world

/**
 * Build the held-out world. Same seed, same world.
 * @param {number} [seed]
 */
export function personalHeldout(seed = 11) {
  const rnd = prng(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  let n = 0;
  const id = () => `55555555-eeee-4000-8000-${String(++n).padStart(12, "0")}`;

  /** @type {{ day: number, kind: string, cwd: string, name?: string, turns: string[] }[]} */
  const plan = [];

  // 80 work sessions over 195 days.
  for (let i = 0; i < 80; i++) {
    const p = PROJECTS[i % PROJECTS.length];
    const day = Math.min(195, Math.floor(i * 195 / 80) + int(0, 1));
    const len = int(5, 8);
    const turns = [];
    const used = new Set();
    for (let k = 0; k < len; k++) {
      let j = int(0, DEV.length - 1);
      while (used.has(j)) j = (j + 1) % DEV.length;
      used.add(j);
      const f = pick(p.files), x = pick(p.parts), num = String(int(3, 420));
      const fill = s => s.replaceAll("{f}", f).replaceAll("{x}", x).replaceAll("{p}", p.label).replaceAll("{n}", num);
      turns.push(fill(DEV[j][0]), fill(DEV[j][1]));
    }
    plan.push({ day, kind: "dev", cwd: `${HOME}/${p.dir}`, name: i % 5 === 0 ? `${p.label} ${["fixes", "polish", "review", "handoff"][(i / 5) % 4]}` : undefined, turns });
  }
  // 14 errands at home.
  for (let i = 0; i < 14; i++) {
    const day = Math.floor(i * 195 / 14) + int(1, 6);
    const turns = [];
    const first = i % HOME_TASKS.length;
    for (let k = 0; k < 3; k++) turns.push(...HOME_TASKS[(first + k * 3) % HOME_TASKS.length]);
    plan.push({ day, kind: "home", cwd: HOME, turns });
  }
  // The noise.
  plan.push({ day: 44, kind: "noise", cwd: `${HOME}/clients/harlow-legal`, name: "reply to owen", turns: EMAIL });
  plan.push({ day: 57, kind: "noise", cwd: `${HOME}/clients/harlow-legal/site`, name: "family law copy", turns: FAMILY_PAGE });
  plan.push({ day: 58, kind: "noise", cwd: `${HOME}/clients/harlow-legal/site`, turns: FAMILY_PAGE.slice(2) });
  plan.push({ day: 66, kind: "noise", cwd: `${HOME}/clients/harlow-legal`, name: "wills personas", turns: PERSONA });
  plan.push({ day: 88, kind: "noise", cwd: `${HOME}/clients/northwind/ordering`, turns: OTHERS });
  plan.push({ day: 37, kind: "noise", cwd: HOME, turns: MAYBE.slice(0, 4) });
  plan.push({ day: 71, kind: "noise", cwd: HOME, turns: MAYBE.slice(4) });
  plan.push({ day: 98, kind: "noise", cwd: HOME, name: "helping theo with the move", turns: BORN });
  for (const d of [27, 88, 150]) plan.push({ day: d, kind: "noise", cwd: `${HOME}/admin`, name: "invoice template", turns: INVOICE });
  // The Capsule's own ask threads. The "where do i live" one is from before the move.
  ASKED.forEach(([q, a], i) => plan.push({ day: 24 + i * 22, kind: "capsule", cwd: SCRATCH, name: `Capsule: ${q.replace(/\?$/, "")}`, turns: [q, a] }));

  // Each aside goes into a session in its window: glued to a user turn half the time, as a turn
  // of its own the other half.
  const hosts = plan.filter(s => s.kind === "dev" || s.kind === "home");
  for (const a of ASIDES) {
    const from = a.from ?? 0, to = a.to ?? 196;
    const window = hosts.filter(s => s.day >= from && s.day < to);
    if (!window.length) throw new Error(`no session between day ${from} and ${to} for: ${a.u}`);
    for (let k = 0; k < (a.n ?? 1); k++) {
      const s = window[Math.floor(rnd() * window.length)];
      const at = 2 * int(0, Math.floor(s.turns.length / 2) - 1);
      if (!a.a && rnd() < 0.5) s.turns[at] = `${a.u}. ${s.turns[at]}`;
      else s.turns.splice(at, 0, a.u, a.a || pick(["ok, no rush.", "Sounds good.", "No problem.", "Got it, carrying on."]));
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
export const HELDOUT_SESSIONS = personalHeldout();
