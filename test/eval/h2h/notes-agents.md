# AGENTS.md

## User
- **Name**: Pax
- **Location**: Portland, OR (2214 NE Alberta St)
- **Birthday**: 3 March
- **Transport**: Bike only (sold Honda Civic 2026-07-05)
- **Pet**: Biscuit, corgi, vet at Alberta Animal Clinic
- **Work**: Harlow Legal retainer Tue/Thu from 2026-09-01; Rivera Studio rest of week
- **Portuguese**: Duolingo streak tracked in notes/portuguese.md
- **Climbing**: Mon/Wed/Fri mornings at gym on Killingsworth
- **Coffee**: Oat flat white, extra shot

---

## Projects

### harlow-site
**Client**: Harlow Legal (Dana Reyes, managing partner)  
**Internal name**: Project Kestrel  
**Contact**: Dana Reyes; intake@harlowlegal.com  
**Stack**: Next.js 14 app router, Tailwind, Biome  
**Hosting**: Netlify (harlow-intake-site)  
**Domain**: harlowlegal.com  
**Database**: Postgres on Neon  
**Key services**:
- Intake form: app/intake/IntakeForm.tsx → app/api/intake/route.ts → intake_submissions table
- Cloudflare Turnstile for spam prevention
- Resend for transactional mail (intake@notify.harlowlegal.com)
- Plausible analytics (domain harlowlegal.com)
- next-intl for Spanish intake at /es/intake
- MDX practice areas in content/practice/*.mdx
- Purge intakes older than 18 months nightly (netlify/functions/purge-intakes.ts)
- Print stylesheet for confirmation page (app/intake/confirmed/print.css)

**Decisions**:
- Astro → Next.js 14 (2026-07-02): Astro islands fought multi-step form; switched to server actions
- Formspree → own Postgres endpoint (2026-07-11): confidentiality for law firm
- Sanity → MDX in repo (2026-07-23): Dana's paralegal edits on GitHub web UI
- Vercel → Netlify (2026-08-24): moved back after Harlow's SSO team account was set up
- Postmark → Resend (2026-09-01): Postmark bounced Dana's firm

**Open issues**: None noted

---

### northwind-orders
**Client**: Northwind Bakery (Mara Lindqvist, ops manager; mara@northwindbakery.com)  
**Stack**: SvelteKit 2.8, Svelte 5, TypeScript, Tailwind, Biome  
**Hosting**: Fly.io (northwind-orders; staging: nw-orders-staging.fly.dev)  
**Database**: Supabase Postgres with RLS for staff  
**Key services**:
- Menu items with Cloudinary CDN (cloud name northwind-bakery)
- Pickup slots: 30-min slots 7:00–13:00, max 8 orders/slot, stored as America/Los_Angeles wall time
- Stripe Payments: 30% deposit at order, manual capture for rest at pickup
- Email confirmations via Resend (orders@northwindbakery.com)
- Staff dashboard with date/status filters (src/routes/admin/+page.svelte)
- Daily prep sheet PDF at 05:00 America/Los_Angeles (scripts/prep-sheet.ts) with allergens
- Holiday pie cap: HOLIDAY_PIE_CAP=30 in src/lib/holiday.ts
- Menu import from CSV (scripts/import-menu.ts)
- Price tiers groundwork: customers.price_tier (retail, cafe, wholesale)

**Decisions**:
- Turso SQLite → Supabase Postgres (2026-08-21): staff logins with RLS
- Stripe Checkout → Square Web Payments (2026-07-15): reconcile with POS; SQUARE_LOCATION_ID LQ7WN2B8KX9
- Square → Stripe PaymentIntents (2026-08-14): Square couldn't handle deposit + capture at pickup
- Twilio SMS → Resend email only (2026-08-18): Mara prefers email
- 15-min slots → 30-min slots (2026-08-04): kitchen can't turn 6 orders in 15 min

**Rates**: 125/h until 2026-08-31; 135/h from 2026-09-01

---

### studio-tools
**Purpose**: Shared tooling for client work  
**Stack**: Node 20, Deno (invoice CLI), Biome, changesets  
**Packages**:
- **invoice**: CLI for invoicing; rates in ~/.config/studio/rates.json; invoice numbers RS-YYMM-NN with counter in ~/.config/studio/counter.json
- **config**: Shared Biome config

**Key tools**:
- bin/invoice: Node CLI with pdfkit for PDFs
- bin/ship: Deploy helper; reads ship.config.json per-client; posts to #deploys Slack channel (SLACK_WEBHOOK_URL)
- bin/new-site: Scaffolds Next.js 14 client site from templates/client-site
- CI: .github/workflows/ci.yml (Node 20, biome check, node --test); required on main
- Release: .github/workflows/release.yml publishes to npm.rivera.internal

**Rates**:
- Harlow: 150/h
- Northwind: 125/h until 2026-08-31; 135/h from 2026-09-01

**Decisions**:
- Node → Deno (2026-07-11): compile single binary
- Deno → Node (2026-08-06): binaries 90MB; needed npm PDF libs anyway
- ESLint/Prettier → Biome (2026-06-24): one tool, faster
- Biome 1 → Biome 2 (2026-09-06): upgraded and migrated config

---

## Notes
- **Housing**: Lease on 418 Grand Ave, Oakland ended 2026-08-31; moved to Portland 2026-08-28; new address 2214 NE Alberta St
- **Vet appointment**: Biscuit, 2 July at 9:00 (past)
- **Mara out**: Week of 2026-08-27, moving to Pearl District; cell 971-555-0123
