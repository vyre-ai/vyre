// @ts-check
// Sealed sessions world for Vyre IQ (ADR 0034). Written blind; never opened by whoever tunes the system.
export const HOME = "/home/ines";
export const ME = { name: "Ines Varga", domains: ["vargaworks.dev"], emails: ["ines@vargaworks.dev"] };
export const T0 = Date.parse("2026-05-04T08:00:00Z");   // fixed, never Date.now()
export const NOW = T0 + 125 * 86_400_000;

const D = 86_400_000;
const M = 60_000;
const BAKE = "/home/ines/Work/bakehouse";
const TIDE = "/home/ines/Work/tidepool";
const LEDG = "/home/ines/Work/ledgerlight";
const CLIN = "/home/ines/Work/clinic-portal";
const GIGS = "/home/ines/Work/gigboard";

/** @type {{ id: string, cwd: string, name?: string, human?: boolean, parent?: string, start: number, turns: { role: "user"|"assistant", text: string }[] }[]} */
export const SESSIONS = [
  {
    id: "5e1d0000-0000-4000-8000-000000000001", cwd: BAKE, name: "bakehouse scaffold", start: T0 + 1 * D + 60 * M,
    turns: [
      { role: "user", text: "new project for ottilie, she owns Crumb & Kettle, the bakery on harbour st. wants online preorders for pickup. next.js app router, typescript. scaffold it pls" },
      { role: "assistant", text: "Scaffolded with create-next-app (Next 14.2, TypeScript, App Router) into /home/ines/Work/bakehouse. Added src/app/(shop)/page.tsx, src/lib/menu.ts with a placeholder menu, and a cart context in src/components/CartProvider.tsx. npm run dev is up. Next is payments: I'd suggest Stripe's Payment Element embedded in our own checkout page so the whole flow stays on-brand." },
      { role: "user", text: "nah i dont want to own a checkout form, PCI stuff, ottilie wont care about branding. just use stripe checkout hosted page" },
      { role: "assistant", text: "Fine, going with hosted Stripe Checkout. Added src/app/api/checkout/route.ts that creates a Checkout Session from the cart and redirects to it. Line items use price_data built from menu.ts. Success URL /thanks, cancel URL /cart." },
      { role: "user", text: "ok. also put the stripe key in env not hardcoded lol" },
      { role: "assistant", text: "Moved it to STRIPE_SECRET_KEY in .env.local and added .env.example with the variable names. .env.local is in .gitignore." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000002", cwd: TIDE, name: "tidepool api init", start: T0 + 2 * D + 120 * M,
    turns: [
      { role: "user", text: "rafe from saltmarsh paddle co called, they rent kayaks and want an api their booking site can hit for tide + forecast so customers stop booking at low tide. go pls, keep it small" },
      { role: "assistant", text: "Created a Go module github.com/vargaworks/tidepool (go 1.21) with cmd/tidepool/main.go and a chi router. Routes: GET /v1/tides?station=... and GET /healthz. It listens on port 8088 by default, overridable with PORT." },
      { role: "user", text: "why 8088" },
      { role: "assistant", text: "8080 is taken on your machine by the syncthing GUI proxy you set up, so 8088 avoids the clash." },
      { role: "user", text: "ok fine. feed creds?" },
      { role: "assistant", text: "The coastal feed client lives in internal/feed/client.go and reads the key from TIDEPOOL_FEED_KEY. It fails fast at startup if the variable is missing." },
      { role: "user", text: "cool, commit" },
      { role: "assistant", text: "Committed on main: 'feat: tides endpoint and feed client'." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000003", cwd: BAKE, name: "cent off totals", start: T0 + 3 * D + 330 * M,
    turns: [
      { role: "user", text: "ottilie says a customer got charged 4.49 for something that says 4.50 on the site?? with the 10% loyalty discount" },
      { role: "assistant", text: "Reproduced it. The discount math in src/lib/pricing.ts applyDiscount multiplies floating point dollars (5.00 * 0.9 comes out as 4.4999999) and then uses Math.floor to get cents, so it truncates to 4.49." },
      { role: "user", text: "fix it properly, not with a +0.001 hack" },
      { role: "assistant", text: "Switched all prices in src/lib/menu.ts to integer cents and rewrote applyDiscount as Math.round(cents * (100 - pct) / 100). Added src/lib/pricing.test.ts with the 4.50 case and a few bundles. vitest passes." },
      { role: "user", text: "ty" },
      { role: "assistant", text: "Committed as 'fix: integer cents for discounts'." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000004", cwd: LEDG, name: "ledgerlight storage", start: T0 + 5 * D + 780 * M,
    turns: [
      { role: "user", text: "side project time. ledgerlight, my budgeting cli in rust. right now it dumps everything into a csv, its getting slow w 3 yrs of data. options?" },
      { role: "assistant", text: "Two realistic options: keep CSV and add an index file, or move to SQLite via rusqlite with a transactions table and a categories table. SQLite gives you real queries for the monthly rollups." },
      { role: "user", text: "sqlite. bundled feature so i dont need system libsqlite" },
      { role: "assistant", text: "Added rusqlite 0.31 with the bundled feature to Cargo.toml. New module src/store/mod.rs with open_store() that creates the schema if missing. The DB path comes from LEDGERLIGHT_DB, defaulting to ~/.local/share/ledgerlight/ledger.db." },
      { role: "user", text: "migrate my old csv once" },
      { role: "assistant", text: "Wrote a one-off `ll migrate-csv <path>` subcommand. Ran it on your 2023 to 2026 export: 14,212 rows inserted, 3 skipped for missing dates." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000005", cwd: GIGS, name: "gigboard kickoff", start: T0 + 6 * D + 180 * M,
    turns: [
      { role: "user", text: "bram oyelaran (he books the acts at the lantern rooms) wants a simple gig listing site. sveltekit, static where possible" },
      { role: "assistant", text: "Scaffolded SvelteKit with adapter-cloudflare in /home/ines/Work/gigboard. Pages: src/routes/+page.svelte for upcoming gigs and src/routes/gig/[slug]/+page.svelte. Dev server runs on port 3000." },
      { role: "user", text: "cloudflare pages yeah. whats the data source gonna be, decide later" },
      { role: "assistant", text: "Left it as a static JSON stub at src/lib/data/gigs.json for now." },
      { role: "user", text: "k" },
      { role: "assistant", text: "Pushed the scaffold to a new repo, vargaworks/gigboard." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000006", cwd: BAKE, start: T0 + 8 * D + 90 * M,
    turns: [
      { role: "user", text: "port clash, gigboard is on 3000. move bakehouse" },
      { role: "assistant", text: "Changed the dev script in package.json to `next dev -p 3100`. Updated the Stripe CLI forward command in the README to localhost:3100/api/stripe/webhook." },
      { role: "user", text: "right the webhook, we need it so orders show as paid" },
      { role: "assistant", text: "Added src/app/api/stripe/webhook/route.ts handling checkout.session.completed; it marks the order paid in the orders table (Vercel Postgres, via drizzle). The signing secret is read from STRIPE_WEBHOOK_SECRET." },
      { role: "user", text: "test it" },
      { role: "assistant", text: "Ran `stripe trigger checkout.session.completed` against the local forwarder: 200, and the order row flipped to paid." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000007", cwd: TIDE, name: "caching", start: T0 + 10 * D + 420 * M,
    turns: [
      { role: "user", text: "the coastal feed rate limits us at 60 req/min and rafe's site hammers it. need caching" },
      { role: "assistant", text: "Proposal: stand up Redis (Upstash or a Fly Redis) and cache feed responses for 10 minutes keyed by station. It survives restarts and works if we scale to multiple machines." },
      { role: "user", text: "no, extra service for a kayak shop is overkill. in memory is fine, its one box" },
      { role: "assistant", text: "OK, dropped Redis. Added hashicorp/golang-lru/v2 with an expirable LRU, 512 entries, 10 minute TTL, in internal/feed/cache.go. Feed calls go through cachedFetch()." },
      { role: "user", text: "10 min ok? tides dont change that fast" },
      { role: "assistant", text: "Tide predictions are fixed per day, so tides now cache for 6 hours and forecast stays at 10 minutes." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000008", cwd: CLIN, name: "northgate portal setup", start: T0 + 12 * D + 60 * M,
    turns: [
      { role: "user", text: "new client: northgate physio. hester quayle is the office manager, shes the one emailing me. they want patients to book online instead of phoning. django pls, postgres" },
      { role: "assistant", text: "Created a Django 5.0 project `portal` in /home/ines/Work/clinic-portal with apps bookings and patients. Postgres runs via docker compose on port 5433 so it doesn't collide with your system Postgres. runserver is on 8001." },
      { role: "user", text: "why 8001" },
      { role: "assistant", text: "Your mkdocs preview usually sits on 8000." },
      { role: "user", text: "whatever. models?" },
      { role: "assistant", text: "Added Practitioner, Slot and Booking in bookings/models.py. Booking has a unique constraint on slot. Secret key comes from DJANGO_SECRET_KEY, database from DATABASE_URL via dj-database-url." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000009", cwd: LEDG, start: T0 + 14 * D + 840 * M,
    turns: [
      { role: "user", text: "clippy is yelling at me" },
      { role: "assistant", text: "22 warnings, mostly needless_borrow and a few redundant clones in src/report/monthly.rs. Fixed all of them; cargo clippy -- -D warnings is clean." },
      { role: "user", text: "add that to ci" },
      { role: "assistant", text: "Added .github/workflows/ci.yml with fmt, clippy -D warnings and test on stable." },
      { role: "user", text: "nice" },
      { role: "assistant", text: "First CI run on main is green." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000010", cwd: BAKE, name: "pickup slots", start: T0 + 15 * D + 120 * M,
    turns: [
      { role: "user", text: "ottilie wants customers to pick a pickup time. slots every 15 min from 7 to 2" },
      { role: "assistant", text: "Added src/lib/slots.ts generateSlots(date) producing 15 minute slots from 07:00 to 14:00, with a cap of 6 orders per slot. Slot picker component is in src/components/SlotPicker.tsx." },
      { role: "user", text: "cap 6 is made up right" },
      { role: "assistant", text: "Yes, placeholder. It's an env var now, SLOT_CAPACITY, default 6." },
      { role: "user", text: "she said 4. set 4" },
      { role: "assistant", text: "Set SLOT_CAPACITY=4 in .env.example and in the Vercel project settings." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000011", cwd: TIDE, name: "tides off by an hour", start: T0 + 18 * D + 540 * M,
    turns: [
      { role: "user", text: "dagny at saltmarsh (she runs their ops desk) says high tide on our api is an hour later than the tide table on the wall. wtf" },
      { role: "assistant", text: "Found it in internal/tides/parse.go. The coastal feed publishes station times in standard time all year (UTC-4), but parseTideTime used time.ParseInLocation with America/Halifax, which applies daylight time in summer. So every summer time comes out one hour late." },
      { role: "user", text: "so fix = fixed offset?" },
      { role: "assistant", text: "Yes. parseTideTime now uses time.FixedZone(\"AST\", -4*3600) and converts to America/Halifax only for display. Added parse_test.go with a July and a January case." },
      { role: "user", text: "ship it after tests" },
      { role: "assistant", text: "go test ./... passes. Committed 'fix: feed times are standard time year round'." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000012", cwd: BAKE, name: "first deploy", start: T0 + 20 * D + 480 * M,
    turns: [
      { role: "user", text: "ok lets get it on vercel so ottilie can click around" },
      { role: "assistant", text: "Linked the repo to a Vercel project `bakehouse` and set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (test mode), SLOT_CAPACITY and POSTGRES_URL. Tagged v0.3.0 and deployed to production at bakehouse-ines.vercel.app today, May 24." },
      { role: "user", text: "stripe webhook in prod?" },
      { role: "assistant", text: "Registered https://bakehouse-ines.vercel.app/api/stripe/webhook in the Stripe dashboard (test mode) and put its signing secret in Vercel. A test order went through and showed paid." },
      { role: "user", text: "sent her the link. shes gonna try it saturday" },
      { role: "assistant", text: "Noted. Test card 4242 4242 4242 4242 works for her in test mode." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000013", cwd: CLIN, name: "reminders", start: T0 + 22 * D + 120 * M,
    turns: [
      { role: "user", text: "hester wants reminders so people stop no-showing. sms" },
      { role: "assistant", text: "Added a reminders app: a management command send_reminders that finds bookings starting in 24 hours and sends an SMS through Twilio. Credentials come from TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. It will run as a cron every 15 minutes." },
      { role: "user", text: "make sure it doesnt double send" },
      { role: "assistant", text: "Added reminder_sent_at on Booking; the command skips anything already stamped and stamps inside the same transaction." },
      { role: "user", text: "good" },
      { role: "assistant", text: "Tests for the skip logic are in reminders/tests.py and pass." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000014", cwd: GIGS, start: T0 + 24 * D + 660 * M,
    turns: [
      { role: "user", text: "make the gig cards less ugly" },
      { role: "assistant", text: "Reworked src/lib/components/GigCard.svelte: poster on the left, date block in a heavy condensed type, support act on its own line. The grid is now auto-fill minmax(280px, 1fr)." },
      { role: "user", text: "the date should say doors time too" },
      { role: "assistant", text: "Added doors to the gig JSON schema and the card shows 'doors 7:30'." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Committed." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000015", cwd: TIDE, name: "fly deploy", start: T0 + 25 * D + 360 * M,
    turns: [
      { role: "user", text: "deploy tidepool somewhere rafe's site can reach" },
      { role: "assistant", text: "Deployed to Fly.io as app tidepool-api in region yul, one shared-cpu-1x machine with 256MB. TIDEPOOL_FEED_KEY is set as a Fly secret. https://tidepool-api.fly.dev/healthz returns ok as of May 29." },
      { role: "user", text: "cors for their domain" },
      { role: "assistant", text: "Added a CORS middleware allowing https://saltmarshpaddle.example and localhost. Redeployed." },
      { role: "user", text: "sent rafe the base url" },
      { role: "assistant", text: "Good. The Fly bill for this should land around 7 dollars a month." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000016", cwd: GIGS, name: "where do gigs come from", start: T0 + 26 * D + 210 * M,
    turns: [
      { role: "user", text: "bram needs to edit gigs himself. hes not technical" },
      { role: "assistant", text: "I'd recommend a headless CMS like Sanity: a studio at /studio, a schema for gigs, and a webhook to rebuild Pages when he publishes." },
      { role: "user", text: "no way, hes never going to learn a cms. he already lives in google sheets. read a published sheet" },
      { role: "assistant", text: "Went with the Google Sheet. src/lib/data/sheet.ts fetches the published CSV from GIGS_SHEET_CSV_URL at build time and parses it with papaparse. Columns: date, doors, headliner, support, ticket_url, poster." },
      { role: "user", text: "rebuild when he edits?" },
      { role: "assistant", text: "Added a Cloudflare Pages deploy hook and a scheduled worker that hits it every hour. A manual rebuild link is in the README for Bram." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000017", cwd: BAKE, human: false, start: T0 + 28 * D + 0 * M,
    turns: [
      { role: "user", text: "Run npm audit in this repository and report any high or critical advisories with the package and the fixed version. Do not modify files." },
      { role: "assistant", text: "npm audit found 1 high advisory: postcss below 8.4.31 (line return parsing), pulled in via next. Fixed in postcss 8.4.31. No critical advisories." },
      { role: "user", text: "Confirm no files were modified." },
      { role: "assistant", text: "Confirmed. git status is clean; no files were modified." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000018", cwd: LEDG, name: "bom", start: T0 + 30 * D + 810 * M,
    turns: [
      { role: "user", text: "import of my bank's new export blows up: `Error: missing field `date` at line 1`. the column is literally called date" },
      { role: "assistant", text: "Sending a subagent to check how the csv reader handles headers." },
      { role: "user", text: "k" },
      { role: "assistant", text: "The header's first bytes are EF BB BF, a UTF-8 BOM (byte order mark), so the first column is named \"\\u{feff}date\" and serde can't match it. The reader is in src/import/csv.rs." },
      { role: "user", text: "strip it" },
      { role: "assistant", text: "import_csv now checks the first three bytes and skips a BOM before handing the reader to serde. Added tests/fixtures/bom_export.csv. Import of your file: 612 rows." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000018/agent-hdr", cwd: LEDG, human: false, parent: "5e1d0000-0000-4000-8000-000000000018", start: T0 + 30 * D + 812 * M,
    turns: [
      { role: "user", text: "Find where ledgerlight reads bank CSV headers and why a header named date might fail to match. Report file and function." },
      { role: "assistant", text: "Headers are read in src/import/csv.rs, function import_csv, via csv::ReaderBuilder with has_headers(true) and serde deserialize into BankRow. Nothing strips a byte order mark, so a BOM would stick to the first header name." },
      { role: "user", text: "Is there an existing test fixture for bank exports?" },
      { role: "assistant", text: "Only tests/fixtures/sample.csv, which has no BOM." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000019", cwd: BAKE, name: "wholesale", start: T0 + 33 * D + 120 * M,
    turns: [
      { role: "user", text: "call with ottilie thursday about a wholesale price list for the cafes she supplies. dont build anything yet, just sketch what the data would look like" },
      { role: "assistant", text: "Sketch: a customers table with a type (retail or wholesale), a price_lists table, and price_list_items keyed by menu item with a wholesale price in cents and a minimum quantity. Wholesale orders would skip Stripe Checkout and be invoiced." },
      { role: "user", text: "invoiced how" },
      { role: "assistant", text: "Simplest would be Stripe Invoices with net 14 terms, but that's a question for thursday." },
      { role: "user", text: "put it in a doc so i can screen share" },
      { role: "assistant", text: "Wrote docs/wholesale.md with the tables and open questions (terms, delivery days, minimums)." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000020", cwd: CLIN, name: "wrong appointment times", start: T0 + 36 * D + 150 * M,
    turns: [
      { role: "user", text: "hester: 'the confirmation email says 3pm but i booked 2pm'. ugh timezones again" },
      { role: "assistant", text: "Root cause is in portal/settings.py: TIME_ZONE was still the default 'UTC'. Slots are created as local clinic times, but with USE_TZ on, Django stored them as 14:00 UTC, and the email template converts to Europe/Dublin, so 14:00 UTC renders as 15:00 in summer." },
      { role: "user", text: "same class of bug as the tide thing lol" },
      { role: "assistant", text: "Pretty much. Set TIME_ZONE = 'Europe/Dublin' and wrote a data migration bookings/migrations/0007_shift_slot_times.py that moves existing future slots back one hour." },
      { role: "user", text: "run it on staging first" },
      { role: "assistant", text: "Ran it on the staging DB: 214 future slots shifted. Spot checked 5 bookings against Hester's paper diary screenshot, all match." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000021", cwd: TIDE, start: T0 + 38 * D + 520 * M,
    turns: [
      { role: "user", text: "logs are unreadable on fly" },
      { role: "assistant", text: "Switched to log/slog with the JSON handler in cmd/tidepool/main.go. A request logging middleware adds station, status and duration_ms." },
      { role: "user", text: "less noisy healthz" },
      { role: "assistant", text: "Healthz requests are now skipped by the logger." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Deployed; fly logs shows one JSON line per request now." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000022", cwd: BAKE, name: "slots 30", start: T0 + 40 * D + 90 * M,
    turns: [
      { role: "user", text: "ottilie: kitchen cant prep for 15 min slots, too many tiny batches. make it 30" },
      { role: "assistant", text: "Changed generateSlots in src/lib/slots.ts to 30 minute intervals, still 07:00 to 14:00. Capacity per slot stays SLOT_CAPACITY. Existing orders on :15 and :45 are kept as they are." },
      { role: "user", text: "should capacity go up since slots are twice as long" },
      { role: "assistant", text: "Probably. 8 would keep the same hourly throughput." },
      { role: "user", text: "she said keep 4 for now, see how it goes" },
      { role: "assistant", text: "Leaving SLOT_CAPACITY at 4." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000023", cwd: GIGS, name: "missing posters", start: T0 + 42 * D + 420 * M,
    turns: [
      { role: "user", text: "posters work locally but half are broken on the live preview" },
      { role: "assistant", text: "The broken ones differ in case between the sheet and the file: the sheet says 'Moth Choir.jpg', the file is static/posters/moth-choir.JPG. posterUrl() in src/lib/posters.ts has a case-insensitive fallback, but it's wrapped in import.meta.env.DEV, so production asks Cloudflare for the exact name and gets a 404." },
      { role: "user", text: "just normalize everything" },
      { role: "assistant", text: "posterUrl now slugifies the sheet value and lowercases the extension, and I renamed all files in static/posters to lowercase slug form. Removed the dev-only fallback so dev and prod behave the same." },
      { role: "user", text: "good, tell bram not to worry about capitals" },
      { role: "assistant", text: "Added a line to the README section for Bram: poster names can be typed any way." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000024", cwd: TIDE, name: "move off fly?", start: T0 + 44 * D + 240 * M,
    turns: [
      { role: "user", text: "rafe asked if hosting can be cheaper. fly bill is like 7 bucks but he wants to bundle it with their hetzner box that runs the booking site" },
      { role: "assistant", text: "Doable: build a static binary, run it under systemd on their Hetzner CX22 behind the existing Caddy, same TIDEPOOL_FEED_KEY in an env file." },
      { role: "user", text: "ok lets plan for that. move it to hetzner next week" },
      { role: "assistant", text: "Wrote deploy/hetzner/tidepool.service, deploy/hetzner/Caddyfile.snippet and a Makefile target build-linux. Not deployed yet; waiting on SSH access from Rafe." },
      { role: "user", text: "yep" },
      { role: "assistant", text: "I'll leave fly.toml in place until the cutover." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000025", cwd: BAKE, name: "webhook 400s", start: T0 + 47 * D + 180 * M,
    turns: [
      { role: "user", text: "orders not flipping to paid since yesterday. stripe dashboard shows webhook failures `No signatures found matching the expected signature for payload`" },
      { role: "assistant", text: "Asking a subagent to check how the webhook route reads the body while I pull the logs." },
      { role: "user", text: "go" },
      { role: "assistant", text: "Found it. Yesterday's refactor in src/app/api/stripe/webhook/route.ts added `const body = await req.json()` for logging, then passed JSON.stringify(body) to stripe.webhooks.constructEvent. Re-serialized JSON isn't byte-identical to what Stripe signed, so verification fails. It must get the raw text." },
      { role: "user", text: "fix + replay the failed ones" },
      { role: "assistant", text: "The route now reads `const raw = await req.text()` and verifies that; logging parses after verification. Replayed 11 failed events from the dashboard, all 200, 11 orders marked paid." },
      { role: "user", text: "tell me that doesnt happen again" },
      { role: "assistant", text: "Added src/app/api/stripe/webhook/route.test.ts, which signs a payload with a test secret and asserts the route accepts it." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000025/agent-raw", cwd: BAKE, human: false, parent: "5e1d0000-0000-4000-8000-000000000025", start: T0 + 47 * D + 183 * M,
    turns: [
      { role: "user", text: "In the bakehouse Next.js repo, inspect src/app/api/stripe/webhook/route.ts and report how the request body reaches stripe.webhooks.constructEvent. Do not edit." },
      { role: "assistant", text: "The handler calls req.json() on line 14, then passes JSON.stringify(body) to constructEvent on line 19. The raw body is never read, so the signature is checked against re-serialized JSON." },
      { role: "user", text: "When did that change land?" },
      { role: "assistant", text: "Commit 4be17d0, 'refactor: log webhook payloads', from the previous afternoon." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000026", cwd: CLIN, name: "go live render", start: T0 + 50 * D + 120 * M,
    turns: [
      { role: "user", text: "hester wants it live monday. deploy" },
      { role: "assistant", text: "Created a Render blueprint render.yaml: web service portal (gunicorn portal.wsgi), a Postgres instance northgate-db, and a cron job for send_reminders. Deployed to Render; booking.northgatephysio.example points at it. Ran migrate and created Hester's staff account. Live as of June 23." },
      { role: "user", text: "static files?" },
      { role: "assistant", text: "Using whitenoise; collectstatic runs in the build command." },
      { role: "user", text: "ok great, live" },
      { role: "assistant", text: "First real booking came in 20 minutes later." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000027", cwd: TIDE, name: "wind overlay", start: T0 + 52 * D + 480 * M,
    turns: [
      { role: "user", text: "rafe wants wind on the forecast, kayakers care more about wind than tide tbh. branch for it" },
      { role: "assistant", text: "Created branch feat/wind-overlay. Bumped go.mod to go 1.22 so I can use the new ServeMux patterns later. Added internal/forecast/wind.go that pulls hourly wind speed and gust from the feed's /marine endpoint." },
      { role: "user", text: "units?" },
      { role: "assistant", text: "The feed gives m/s; the API returns knots, since that's what the Saltmarsh staff use. Field names are wind_kt and gust_kt." },
      { role: "user", text: "ok. keep it on the branch till rafe sees it" },
      { role: "assistant", text: "Pushed feat/wind-overlay; nothing merged to main." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000028", cwd: GIGS, name: "gigboard live", start: T0 + 55 * D + 300 * M,
    turns: [
      { role: "user", text: "bram's happy with preview, put it on the real domain" },
      { role: "assistant", text: "Added gigs.lanternrooms.example as a custom domain on the Cloudflare Pages project gigboard, production branch main. DNS CNAME is proxied and the cert is issued. Deployed commit 9c41e2a on June 28." },
      { role: "user", text: "is the hourly rebuild still on" },
      { role: "assistant", text: "Yes, the scheduled worker gigboard-rebuild still hits the deploy hook at minute 5 of every hour." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Sent you the live URL to forward to Bram." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000029", cwd: CLIN, start: T0 + 57 * D + 620 * M,
    turns: [
      { role: "user", text: "hester wants to see bookings by practitioner in the admin" },
      { role: "assistant", text: "Added list_filter on practitioner and date, and a date_hierarchy on slot start in bookings/admin.py." },
      { role: "user", text: "and she cant delete bookings, only cancel" },
      { role: "assistant", text: "Removed delete permission for the Front desk group and added a Cancel action that sets status=cancelled. Migration 0009 drops the unique constraint on Booking.slot so cancelled bookings can keep their row." },
      { role: "user", text: "ty" },
      { role: "assistant", text: "Deployed to Render." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000030", cwd: TIDE, name: "staying on fly", start: T0 + 60 * D + 210 * M,
    turns: [
      { role: "user", text: "change of plan on hetzner. dagny said their box gets restarted by the booking vendor whenever they push updates and they dont want our api going down with it. stay on fly" },
      { role: "assistant", text: "Understood, tidepool stays on Fly.io. Do you want deploy/hetzner kept in the repo marked unused, or deleted?" },
      { role: "user", text: "delete it, dead code" },
      { role: "assistant", text: "Removed deploy/hetzner and the build-linux target. fly.toml stays the only deploy config." },
      { role: "user", text: "tell rafe the bill stays 7" },
      { role: "assistant", text: "Drafted a short note for you to send Rafe: hosting stays on Fly, about 7 dollars a month." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000031", cwd: LEDG, name: "publish", start: T0 + 61 * D + 780 * M,
    turns: [
      { role: "user", text: "want to put ledgerlight on crates.io, a couple ppl on the forum asked" },
      { role: "assistant", text: "The name ledgerlight is free on crates.io. Filled in Cargo.toml metadata (license MIT OR Apache-2.0, repository, description) and added an install section to the README. cargo publish --dry-run is clean." },
      { role: "user", text: "version?" },
      { role: "assistant", text: "Cargo.toml says 0.4.1. The storage change since that tag is breaking, so I'd publish as 0.5.0 to be honest about it." },
      { role: "user", text: "0.4.2, nobody but me has a db" },
      { role: "assistant", text: "Bumped to 0.4.2 and ran cargo publish. ledgerlight 0.4.2 is live on crates.io as of July 4." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000032", cwd: CLIN, name: "reminders to email", start: T0 + 64 * D + 120 * M,
    turns: [
      { role: "user", text: "hester says the twilio bill for june was higher than the phone line lol. drop sms, email reminders only" },
      { role: "assistant", text: "Switched send_reminders to email through their Google Workspace SMTP relay. Removed the Twilio client and the TWILIO_* env vars from render.yaml. Still sent 24 hours before." },
      { role: "user", text: "and add a cancel link in the email" },
      { role: "assistant", text: "Added a signed cancel link (django.core.signing, 7 day max age) to templates/emails/reminder.txt that hits /bookings/cancel/<token>/." },
      { role: "user", text: "ok deploy" },
      { role: "assistant", text: "Deployed to Render. Sent a test reminder to your address; the cancel link works." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000033", cwd: BAKE, start: T0 + 66 * D + 370 * M,
    turns: [
      { role: "user", text: "menu photos from jonah are huge, like 8mb each" },
      { role: "assistant", text: "Moved the photos in public/menu to next/image with sizes set, and resized the sources to 1600px webp. The largest is now 210KB." },
      { role: "user", text: "jonah is ottilie's nephew, he does their instagram, hell send more. can he drop them somewhere" },
      { role: "assistant", text: "Made a menu-photos folder in Vercel Blob and a small upload page at /admin/photos behind the ADMIN_PASSWORD env var." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Uploads get resized to 1600px webp on the way in." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000034", cwd: GIGS, start: T0 + 68 * D + 720 * M,
    turns: [
      { role: "user", text: "sold out gigs should look sold out" },
      { role: "assistant", text: "Added a sold_out column to the sheet parser; cards get a diagonal 'sold out' band and the ticket button is hidden." },
      { role: "user", text: "cool" },
      { role: "assistant", text: "Bram only needs to type yes in the sold_out column." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000035", cwd: BAKE, name: "order emails", start: T0 + 70 * D + 120 * M,
    turns: [
      { role: "user", text: "customers want an email receipt with the pickup time, stripe's receipt doesnt show it" },
      { role: "assistant", text: "I'd use Resend: simple API, React email templates, and the free tier covers this volume." },
      { role: "user", text: "ottilie already pays for postmark for the newsletter, use that" },
      { role: "assistant", text: "Switched to Postmark. src/lib/email.ts sends the OrderConfirmed template via the Postmark API, token in POSTMARK_SERVER_TOKEN, sent from orders@crumbandkettle.example. It fires from the webhook after the order is marked paid." },
      { role: "user", text: "test" },
      { role: "assistant", text: "Sent a test order: the email arrived with pickup slot 09:30 and the item list." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000036", cwd: LEDG, start: T0 + 72 * D + 820 * M,
    turns: [
      { role: "user", text: "monthly report sorting is weird, groceries under utilities" },
      { role: "assistant", text: "Categories were sorted by id rather than name in src/report/monthly.rs. They're now sorted by total spend descending, with a --sort name flag." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Committed with a snapshot test for the ordering." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000037", cwd: CLIN, name: "double bookings", start: T0 + 75 * D + 90 * M,
    turns: [
      { role: "user", text: "two patients booked the same 9am slot with dr pike this morning. i thought we had a unique constraint??" },
      { role: "assistant", text: "Sending an agent to write a concurrency test while I read reserve_slot." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Two things. Migration 0009 (from the cancel action) dropped the unique constraint on Booking.slot so cancelled bookings could keep their row. And reserve_slot in bookings/services.py checks the slot is free and then creates the booking with no lock, so two requests 40ms apart both passed the check." },
      { role: "user", text: "fix both" },
      { role: "assistant", text: "reserve_slot now runs in transaction.atomic with Slot.objects.select_for_update().get(pk=...), and I added a partial UniqueConstraint on slot where status='confirmed' (migration 0012). The agent's test in bookings/tests/test_concurrency.py fires 10 threads at one slot; exactly one wins." },
      { role: "user", text: "deploy, ill let hester sort out the two patients" },
      { role: "assistant", text: "Deployed to Render; migration 0012 applied after I cancelled the later of the two duplicate bookings." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000037/agent-race", cwd: CLIN, human: false, parent: "5e1d0000-0000-4000-8000-000000000037", start: T0 + 75 * D + 94 * M,
    turns: [
      { role: "user", text: "Write a TransactionTestCase in bookings/tests/test_concurrency.py that calls reserve_slot from 10 threads for the same slot and asserts exactly one confirmed booking. Do not change bookings/services.py." },
      { role: "assistant", text: "Added bookings/tests/test_concurrency.py using TransactionTestCase and a threading.Barrier so all 10 calls start together. On the current code it fails: 2 to 4 confirmed bookings per run." },
      { role: "user", text: "Does it need Postgres or does sqlite work?" },
      { role: "assistant", text: "It needs Postgres; sqlite serializes writes and hides the race. It uses the docker compose database on 5433." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000038", cwd: TIDE, human: false, start: T0 + 78 * D + 0 * M,
    turns: [
      { role: "user", text: "Run go test ./... and go vet ./... on branch main. Summarize failures with file and line. Do not push." },
      { role: "assistant", text: "go vet: clean. go test: 1 failure. internal/feed/cache_test.go:41 TestTTLExpiry is flaky: it sleeps 50ms against a 50ms TTL. All other packages pass." },
      { role: "user", text: "Rerun the failing test 20 times and report the failure rate." },
      { role: "assistant", text: "TestTTLExpiry failed 6 of 20 runs." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000039", cwd: TIDE, name: "forecast 500s", start: T0 + 80 * D + 360 * M,
    turns: [
      { role: "user", text: "rafe: booking page shows 'forecast unavailable' since early this morning. fly logs: `panic: runtime error: index out of range [0] with length 0`" },
      { role: "assistant", text: "Starting an agent to trace where forecast windows are combined." },
      { role: "user", text: "k" },
      { role: "assistant", text: "The panic is in mergeWindows in internal/forecast/merge.go. It reads windows[0] to seed the merge. Overnight the feed returned an empty array for station 8401 (their sensor is down), so windows had length 0." },
      { role: "user", text: "dont 500 the whole thing if one station is empty" },
      { role: "assistant", text: "mergeWindows returns nil for empty input, and the handler returns 200 with \"forecast\": [] plus \"stale\": true for that station. Added a test with an empty feed payload. Deployed to Fly; /v1/forecast?station=8401 returns 200." },
      { role: "user", text: "also that flaky ttl test from the nightly run" },
      { role: "assistant", text: "Fixed internal/feed/cache_test.go to use an injectable clock instead of sleeping." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000039/agent-trace", cwd: TIDE, human: false, parent: "5e1d0000-0000-4000-8000-000000000039", start: T0 + 80 * D + 363 * M,
    turns: [
      { role: "user", text: "In tidepool, find the function that combines forecast windows for /v1/forecast and any place it indexes a slice without a length check. Report file, function and line." },
      { role: "assistant", text: "The /v1/forecast handler in internal/api/forecast.go calls forecast.mergeWindows in internal/forecast/merge.go. Line 23 reads windows[0] with no length check." },
      { role: "user", text: "Any other unchecked indexing in that package?" },
      { role: "assistant", text: "No. wind.go ranges over its slices and never indexes directly." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000040", cwd: BAKE, start: T0 + 83 * D + 520 * M,
    turns: [
      { role: "user", text: "add a 'sold out today' toggle for items" },
      { role: "assistant", text: "Added an available_today boolean to menu items with a toggle on /admin/menu. Sold out items render greyed out and can't be added to the cart. They reset at 2am via a Vercel cron hitting /api/cron/reset-availability." },
      { role: "user", text: "2am local right not utc" },
      { role: "assistant", text: "Vercel cron runs in UTC, so the schedule is 0 1 * * *, which is 2am local in summer. I left a comment to move it to 0 2 in winter." },
      { role: "user", text: "ugh fine" },
      { role: "assistant", text: "Deployed." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000041", cwd: GIGS, name: "bram feedback", start: T0 + 85 * D + 220 * M,
    turns: [
      { role: "user", text: "bram sent a list. branch for it" },
      { role: "assistant", text: "Created branch bram-feedback. From his list: bigger ticket button, show 'free entry' when ticket_url is empty, and add a genre tag." },
      { role: "user", text: "ticket button should go to the vendor page not our own page" },
      { role: "assistant", text: "The button now links straight to ticket_url (their ticket vendor, TixTent) in a new tab; if it's empty the card shows 'free entry'. Genre comes from a new genre column." },
      { role: "user", text: "merge when he oks" },
      { role: "assistant", text: "Opened a PR from bram-feedback to main and posted the preview URL for Bram." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000042", cwd: CLIN, start: T0 + 88 * D + 450 * M,
    turns: [
      { role: "user", text: "hester needs a csv of last months bookings for the accountant" },
      { role: "assistant", text: "Added an 'Export CSV' admin action in bookings/admin.py with patient name, practitioner, start, status and price. Exported July: 388 bookings." },
      { role: "user", text: "send me the file" },
      { role: "assistant", text: "Saved to exports/bookings-2026-07.csv in the project folder." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000043", cwd: LEDG, name: "clap derive", start: T0 + 90 * D + 840 * M,
    turns: [
      { role: "user", text: "my hand-rolled arg parsing is a mess. clap?" },
      { role: "assistant", text: "Moved to clap 4 with the derive API: src/cli.rs has a Cli struct and a Command enum (Add, Import, Report, MigrateCsv). Help text is generated now." },
      { role: "user", text: "rename report to tally, its what i type anyway" },
      { role: "assistant", text: "Renamed the subcommand to tally and kept report as a hidden alias so old scripts still work." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Committed; CI green." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000044", cwd: TIDE, start: T0 + 93 * D + 550 * M,
    turns: [
      { role: "user", text: "readme is stale" },
      { role: "assistant", text: "Rewrote the README: endpoints /v1/tides and /v1/forecast, env vars TIDEPOOL_FEED_KEY and PORT, and the fly deploy steps." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Committed on main." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000045", cwd: BAKE, name: "launch", start: T0 + 95 * D + 60 * M,
    turns: [
      { role: "user", text: "ottilie wants it live for real before the harvest fair on saturday. switch stripe to live mode" },
      { role: "assistant", text: "Swapped the Vercel env to the live STRIPE_SECRET_KEY and a new live webhook endpoint with its own STRIPE_WEBHOOK_SECRET. Pointed order.crumbandkettle.example at the Vercel project. Tagged v1.0.0 and deployed to production on Aug 7." },
      { role: "user", text: "do a real order" },
      { role: "assistant", text: "Placed a live 3.20 order for a cardamom bun with your card: it showed paid, the Postmark email arrived, then I refunded it in the dashboard." },
      { role: "user", text: "yesss. telling her" },
      { role: "assistant", text: "The test-mode webhook endpoint is disabled so it can't mark live orders." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000046", cwd: GIGS, start: T0 + 98 * D + 620 * M,
    turns: [
      { role: "user", text: "bram merged it? check" },
      { role: "assistant", text: "Yes, the PR from bram-feedback was merged yesterday after Bram's ok, and production redeployed." },
      { role: "user", text: "delete branch" },
      { role: "assistant", text: "Deleted bram-feedback locally and on origin." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000047", cwd: CLIN, name: "demo prep", start: T0 + 100 * D + 120 * M,
    turns: [
      { role: "user", text: "demo for hester and lorcan pike friday. lorcan is the physio who owns the practice. what should i show" },
      { role: "assistant", text: "Suggested order: a patient books a slot on a phone, the reminder email with its cancel link, Hester's admin filters and CSV export, then the double-booking fix with the concurrency test output." },
      { role: "user", text: "and ask them about online payments for no-show fees" },
      { role: "assistant", text: "Added that to docs/demo-notes.md as an open question, along with the deposit amount and refund window." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Also seeded the staging DB with a fake week of bookings for the demo." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000048", cwd: LEDG, start: T0 + 103 * D + 800 * M,
    turns: [
      { role: "user", text: "someone opened an issue saying tally crashes on empty db" },
      { role: "assistant", text: "Reproduced: tally divided by the month count, which is 0 on an empty store. It now prints 'no transactions yet' and exits 0. Released as 0.4.3 on crates.io." },
      { role: "user", text: "thx" },
      { role: "assistant", text: "Closed the issue with a link to the release." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000049", cwd: BAKE, start: T0 + 105 * D + 420 * M,
    turns: [
      { role: "user", text: "fair went ok? ottilie says 140 preorders lol" },
      { role: "assistant", text: "Checked the orders table: 142 paid orders for the fair weekend, busiest slot Saturday 08:30 with 4 orders (at capacity). No webhook failures." },
      { role: "user", text: "nice" },
      { role: "assistant", text: "Postmark shows all 142 confirmation emails delivered." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000050", cwd: CLIN, start: T0 + 108 * D + 220 * M,
    turns: [
      { role: "user", text: "render says postgres is at 80% of the plan storage" },
      { role: "assistant", text: "The biggest table is django_session at 1.9GB; sessions were never cleared. Added clearsessions to the daily Render cron. Storage is at 11% after the first run." },
      { role: "user", text: "lol ok" },
      { role: "assistant", text: "Also set SESSION_COOKIE_AGE to two weeks so it doesn't grow back as fast." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000051", cwd: TIDE, name: "wind release", start: T0 + 110 * D + 320 * M,
    turns: [
      { role: "user", text: "rafe finally looked at the wind stuff, loves it. merge and release" },
      { role: "assistant", text: "Merged feat/wind-overlay into main, tagged v2.1.0 and deployed to Fly. /v1/forecast now includes wind_kt and gust_kt per hour." },
      { role: "user", text: "why 2.1 we were on 1.x" },
      { role: "assistant", text: "You tagged v2.0.0 in June when the tides response changed shape (height_m instead of height). I kept going from there." },
      { role: "user", text: "ah right" },
      { role: "assistant", text: "Release notes are in CHANGELOG.md." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000052", cwd: GIGS, start: T0 + 113 * D + 670 * M,
    turns: [
      { role: "user", text: "some old gigs still show up" },
      { role: "assistant", text: "The filter compared date strings, and Bram typed some dates without zero padding, so '2026-8-9' sorts after '2026-08-20'. Dates are now parsed before filtering." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Deployed; past gigs are gone from the list." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000053", cwd: GIGS, name: "dark mode", start: T0 + 115 * D + 520 * M,
    turns: [
      { role: "user", text: "bram wants dark mode, apparently the venue is dark and people read it on the stairs lol" },
      { role: "assistant", text: "Added a dark theme with CSS variables in src/app.css driven by prefers-color-scheme, and a header toggle that stores the choice in localStorage." },
      { role: "user", text: "make dark the default" },
      { role: "assistant", text: "Dark is now the default; the toggle switches to light." },
      { role: "user", text: "deploy" },
      { role: "assistant", text: "Deployed to Cloudflare Pages production." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000054", cwd: LEDG, start: T0 + 118 * D + 820 * M,
    turns: [
      { role: "user", text: "can tally output json" },
      { role: "assistant", text: "Added --format json to tally, emitting month, category and total_cents." },
      { role: "user", text: "and csv?" },
      { role: "assistant", text: "Added --format csv as well." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000055", cwd: CLIN, start: T0 + 120 * D + 120 * M,
    turns: [
      { role: "user", text: "hester asks if patients can pick a practitioner or just 'anyone'" },
      { role: "assistant", text: "Added an 'Any practitioner' option to the booking form; it picks the earliest free slot across all practitioners." },
      { role: "user", text: "good" },
      { role: "assistant", text: "Deployed to Render." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000056", cwd: BAKE, start: T0 + 122 * D + 420 * M,
    turns: [
      { role: "user", text: "ottilie asked about the wholesale thing again" },
      { role: "assistant", text: "docs/wholesale.md still has the open questions from June. Nothing is built. Want me to start the price_lists tables?" },
      { role: "user", text: "not yet, she hasnt sent the cafe list" },
      { role: "assistant", text: "OK, parked." },
    ],
  },
  {
    id: "5e1d0000-0000-4000-8000-000000000057", cwd: TIDE, start: T0 + 124 * D + 220 * M,
    turns: [
      { role: "user", text: "fly says the machine restarted twice today" },
      { role: "assistant", text: "Both were OOM kills at 256MB during the 06:00 cache warm. Bumped the machine to 512MB in fly.toml and redeployed." },
      { role: "user", text: "ok" },
      { role: "assistant", text: "Memory peaks at 310MB now." },
    ],
  },
];
