# site-copy: rewrite every word on vyre.run

## Scope

`site/index.html`, `site/start/index.html`, `site/404.html`, the user-facing strings in
`site/app.js`. Words only: layout and CSS stay. Rules: `stop-slop` (mandatory) and the lead's brief
("the opposite of Claudespeak": plain, concrete, short sentences, honest about what it needs).

Fact sources: `README.md`, `docs/known-gaps.md`, `docs/concepts/floor.md`, `docs/using/*.md`
(capsule, vault, glass, mobile), `docs/get-started/first-day.md`. `docs/design/anywhere.md` does not
exist on this branch. Where the old page claimed more than the docs, the new copy says less.

## 1. The old copy, diagnosed

| Where | Old copy | Diagnosis |
|---|---|---|
| title / og:title | Vyre: your work partner, on a machine you own | "Work partner" is a metaphor. Says nothing about Claude Code. |
| meta description | Vyre remembers every session, keeps every account in one place, and works beside you on a machine you own. | Triplet. "Works beside you" means nothing concrete. |
| og / twitter description | Your best work, with a partner that never drops the thread. | Idiom plus metaphor. A reader can't tell what the product is. |
| eyebrow | Open source · Apache 2.0 · Built on Claude Code | Three labels. Fine as facts, trimmed to two. |
| H1 | Your best work, with a partner that never drops the thread. | The line the user named. "Partner", "drops the thread", "your best work": three abstractions, zero facts. |
| Lead | Vyre remembers every session, keeps every account in one place, and works beside you on a machine you own. Ask anything with a keystroke. Watch it work. Step in whenever you like. | A triplet, then three staccato imperatives in a row. Never says the one useful fact: sessions run on your server. |
| Linux tab | Run the line above ... then hands you your onboarding link. The rest happens in your browser. | Close to fine. "Hands you" is a small personification. |
| Mac tab | This puts Vyre on your Mac as a device that pairs with your server (Linux only) over your tailnet. | Jargon ("device", "tailnet") and never says plainly that you need the server first. |
| Hint | Press ⌥Space to try the Capsule right here. / Or open it | "Or open it" is vague. |
| Gate line | Everything inside this line runs on your own network. | Fine idea, kept. |
| 01 Capsule H2 | Ask without leaving what you're doing. | Abstract. "What you're doing" names nothing. |
| 01 Capsule body | ... Say what you need. It's gone when you're done. | Cute closer. Doesn't say what happens to your message. |
| 01 feats | "See where it goes", "Say it out loud", "Answers from memory" | Slogan-shaped labels. Descriptions OK. |
| 02 Memory H2 | It remembers, and shows you where from. | Vague "It". Doesn't say what it remembers. |
| 02 Memory body | Every session you run goes into your memory ... No model is used to recall it. Everything else came from the model. | The last two sentences confuse. Nobody outside the team knows what "no model used" buys them. |
| 02 IQ | The new memory engine: better recall across every project. | Colon reveal, "every" doing vague work. |
| 03 Vault H2 | Every account, one place. | Fragment slogan. |
| 03 feats | "Sealed values": No vault value shows on any screen, log or event. | Jargon label, triplet, and not quite true: you can see a value after you confirm it's you. |
| 04 Glass H2 | Watch it work. Take over any time. | Two-beat slogan. "It" again. |
| 04 Glass body | Take the wheel when you want to, and hand it back ... | Metaphor. |
| 05 Deck H2 | Your desk, and your pocket. | Metaphor. |
| 05 Deck body | ... The phone app brings approvals and Glass with you. | Overclaims: no native phone app is released. The phone runs the Deck from the home screen. |
| 05 address | Type your name. Only your devices can open it. | Shows alex.vyre.run as if it works. Today the address is your Tailscale name; vyre.run names are not built. |
| 06 H2 | Open source, and built from pieces. | Vague. |
| 06 body | ... through the same open door you'd use yourself. | Metaphor, long sentence. |
| 06 feats | Apache 2.0: Read every line, change what you like, send it back if you want. | Triplet. |
| 07 label / H2 | The floor / Rules no setting can switch off. | Internal jargon. |
| 07 body | The model can't talk its way past them. | Personification. |
| 07 rule 3 | Every file change shows, including ones a command made quietly. | Untrue today: floor.md says Bash changes are not recorded. |
| Outside line | Holds one DNS record for your name. None of your data. | Describes the unbuilt name directory. Today vyre.run hosts the page and the installer. |
| FAQ H2 | Good questions, straight answers. | Slogan. |
| FAQ "Do I need a server?" | ... You can also start on your Mac and add a server later. | Untrue today: the Mac install pairs with a server. Mac-only mode is coming. |
| Closing H2 | Let's get to work. | Cliche. |
| GitHub line | Star it, read it, fork it. | Triplet. |
| Footer | Made for people who like finishing things. | Pull-quote. |
| Demo dialog foot | ... opens over any app and is gone when you're done. | Cute. |
| 404 H1 / lead | This page wandered off. / kit went looking for it and came back with a coffee instead. | Whimsy, personification. The opposite of plain. |
| 404 label | Where were you headed? | Wh- opener, cute. |
| /start lead | The exact steps, in order. | Fragment. |
| /start body | ... The steps below already account for that. | Filler. |
| /start step 03 | The Deck screen that approves a Mac is not built yet. | Out of date: known-gaps.md says the Deck approves pairing now, from a phone or another computer. |
| /start onboarding | Your history and Your devices can be skipped for now | Passive. |
| app.js demo | Demo: this would go to juno. Nothing left this page. | OK, tightened. |

## 2. Headline options

1. **Run Claude Code on your own server.**
   Sessions you start in Vyre run on the server, so they keep going after you close your laptop.
   Vyre also reads every Claude Code session you run. Next month you can ask what you decided about
   the Harlow contract, and you get the answer with the session it came from.
2. **Your Claude Code sessions keep running when you close your laptop.**
   Vyre moves Claude Code onto a Linux server you own and makes every session searchable.
3. **Claude Code on a server you own, with search across every session.**
   Close your laptop and your agents keep working. Ask about a decision from last month and see
   the session it came from.

Pick: **1**. It names the product and what it does in six words. The subhead carries the two
concrete benefits, each with an example a founder would say out loud. Option 2 is a strong line but
buries "server". Option 3 stacks two ideas into one headline and reads like a spec sheet.

## 3. Before and after, with stop-slop scores

Scores: Directness, Rhythm, Trust, Authenticity, Density (1 to 10 each). Old scores are for the
old copy, new for the rewrite. 35 is the floor.

| Section | Before | After | Old | New |
|---|---|---|---|---|
| Title | Vyre: your work partner, on a machine you own | Run Claude Code on your own server · Vyre | 4/5/5/3/5 = 22 | 9/8/9/9/9 = 44 |
| Meta description | Vyre remembers every session, keeps every account in one place, and works beside you on a machine you own. ... | Vyre runs Claude Code on a Linux server you own. Your sessions keep going when you close your laptop, and you can search all of them later. Free and open source. | 5/4/6/4/6 = 25 | 9/8/9/8/9 = 43 |
| og description | Your best work, with a partner that never drops the thread. ... | Claude Code on a Linux server you own. Sessions keep going when your laptop is closed, and you can search every one. Open source. | 2/5/4/2/5 = 18 | 9/8/9/8/8 = 42 |
| Hero H1 + lead | Your best work, with a partner that never drops the thread. / Vyre remembers every session, ... Watch it work. Step in whenever you like. | Run Claude Code on your own server. / Sessions you start in Vyre run on the server, so they keep going after you close your laptop. Vyre also reads every Claude Code session you run. Next month, ask what you decided about the Harlow contract and you get the answer, with the session it came from. | 3/4/5/3/5 = 20 | 9/8/9/9/8 = 43 |
| Install tabs | ... then hands you your onboarding link. / This puts Vyre on your Mac as a device that pairs with your server ... | Run this on your Linux server. It needs Docker, and it asks before installing it. Vyre goes in /srv/vyre, and the installer prints a link. You finish setup in your browser. / This connects your Mac to your Vyre server over Tailscale, so set up the server first. A Mac-only setup is coming. Vyre isn't on npm yet, so you install it from the same file the server uses. | 7/6/7/6/7 = 33 | 9/8/9/8/8 = 42 |
| 01 Capsule | Ask without leaving what you're doing. / ... Say what you need. It's gone when you're done. | Press ⌥Space in any app and type what you need. / The Capsule is a small bar that opens on top of whatever you have open, a call or a doc. Type a question and your assistant answers it. Start with @kit and the message goes to the agent named kit instead. Esc closes it. | 6/5/6/5/7 = 29 | 9/8/8/8/8 = 41 |
| 02 Memory | It remembers, and shows you where from. / ... No model is used to recall it. Everything else came from the model. | Search every Claude Code session you've run. / Vyre reads your sessions and keeps a record you can search. Ask when Harlow Legal wants the drafts, and you get "Friday before noon" with a link to the call where they said it. Answers from your sessions show up in their own color. Anything without a source, Claude wrote. | 5/6/6/5/6 = 28 | 9/8/9/8/8 = 42 |
| 03 Vault | Every account, one place. / ... Agents use a credential without ever seeing it. | Keep your passwords and API keys on your own server. / The vault holds logins with their one-time codes, and your API keys. An agent can sign in to your billing portal with a password it never sees. | 6/5/6/5/7 = 29 | 9/8/9/8/9 = 43 |
| 04 Glass | Watch it work. Take over any time. / ... Take the wheel when you want to ... | Give an agent its own computer and watch the screen. / An agent can get its own desktop on your server, with Chrome and a terminal. You watch it live in the Deck, from your laptop or your phone. Press Take over to use the keyboard yourself, then hand it back. | 5/5/6/4/7 = 27 | 9/8/9/8/8 = 42 |
| 05 Deck | Your desk, and your pocket. / ... The phone app brings approvals and Glass with you. ... | Check on your agents from a browser or your phone. / The Deck is a web page on your server. It lists what each agent is doing and what's waiting for you. Only devices on your Tailscale network can open it. On a phone, add the Deck to your home screen and you get a notification when a draft needs your OK. | 4/6/5/4/6 = 25 | 9/8/9/8/8 = 42 |
| 06 Open source | Open source, and built from pieces. / ... through the same open door you'd use yourself. | Open source. Switch off the parts you don't use. / Vyre is a Claude Code plugin and a small daemon. The Capsule, Glass, memory and the vault are separate modules, each with its own switch in Settings. They talk to each other through the same API you can call from your own code. | 5/5/6/5/6 = 27 | 9/8/9/8/8 = 42 |
| 07 Safety rules | The floor / Rules no setting can switch off. / The model can't talk its way past them. | Safety rules / Rules Vyre keeps whatever your settings say. / Vyre checks these in code that runs outside Claude, so a prompt can't turn them off. A few are only partly enforced today, and the security doc lists which. | 6/6/6/5/7 = 30 | 9/8/9/8/8 = 42 |
| Outside line | Holds one DNS record for your name. None of your data. | Hosts this page and the installer. Your data never goes through it. | 6/6/6/6/7 = 31 (and untrue) | 9/8/9/8/9 = 43 |
| FAQ | Good questions, straight answers. / ... You can also start on your Mac and add a server later. | Common questions / Yes, for now. Vyre needs a Linux server with Docker, like a small cloud server or a spare PC at home. Your Mac connects to it. A setup that runs on one Mac, with no server, is coming. | 6/6/6/5/7 = 30 | 9/8/9/9/8 = 43 |
| Closing + footer | Let's get to work. / Star it, read it, fork it. / Made for people who like finishing things. | Install Vyre with one command. / The code is on GitHub. / Open source under Apache 2.0. | 3/5/5/3/6 = 22 | 9/7/9/8/9 = 42 |
| 404 | This page wandered off. / kit went looking for it and came back with a coffee instead. / Where were you headed? | There's no page at this address. / The link might be old, or the address has a typo. Type what you were looking for and press Enter. / Find a page | 5/6/5/4/6 = 26 | 9/8/9/8/9 = 43 |
| /start | The exact steps, in order. / The steps below already account for that. / The Deck screen that approves a Mac is not built yet. | Every step, in the order you run them. / (cut) / Approve it in the Deck on your phone, or on another computer on your tailnet. | 7/6/7/6/7 = 33 | 9/8/9/8/8 = 42 |

## Done

- Rewrote every string in `site/index.html`, `site/404.html`, `site/start/index.html`, and the demo
  strings in `site/app.js`. Layout and CSS untouched.
- Fixed claims the old page made that the docs don't back: the phone app (it's the Deck on the home
  screen), `<you>.vyre.run` (it's your Tailscale name today), "start on your Mac" (a server is needed
  today), Bash file changes on the safety list (not recorded yet), and the /start pairing note.

## Demo wiring (lead asked site-copy to take it)

Fixed: see site/CHANGELOG.md. Every control on the page now does something, and none needs a backend.
CDP check on testbox: 34/34 pass, console clean on /, /start and /404. Screenshots
check-dialog.png, check-dialog-390.png and check-hero-after-try.png sit next to the others.

## Found earlier (now fixed, above)

- `site/app.js` doesn't wire the hero Capsule demo. It looks for `[data-cap-tabs]`, `#cap-field`,
  `#cap-demo` and `[data-dest-name]`, none of which exist in `site/index.html` (the page uses
  `data-capsule`, `data-try`, `.cap-field`, `#demo-mount`). The live vyre.run serves the same
  app.js (same sha1), so the Try buttons, the Typing/Recall/Held/Waiting tabs and the ⌥Space dialog
  do nothing, and `demoTabs.addEventListener` throws at load. Needs an owner (launch).

## Screenshots

CDP device-metrics screenshots on testbox (true 390 px, no `--window-size` clamp) of the committed
site, served from a `git archive` export. Local only, not committed: landing, /start and 404 at
1440 and 390 (full page), plus hero viewports. No horizontal scroll at 390 on any page
(scrollWidth 390). Server and Chrome torn down after.

## Doing

Standing by. Deployed: site-copy published vyre.run from caa157f7 (deploy 170fab6b) on 2026-09-28.
vyre.run, /start and /install.sh return 200. Merged main into work/site-copy first (a6713e84, 186
commits; only CHANGELOG.md/docs/index.json/docs/reference/index.md conflicted, resolved by keeping
both changelog sections and regenerating the doc index via `npm run docs:ref`).

New hero H1 "Claude Code, running on your own machine." and lead "Agents that keep working when
you close the laptop. Your memory, your keys, your server. ..." (the user's approved copy for the
GitHub social image), carried into title/meta description/og+twitter title+description. Replaced
site/og.png with the approved 1280x640 image; og:image:width/height/alt updated to match.

Also did the "Vyre anywhere" partial rewrite this doc's old Next section called for, now that
`vyre up --box` (Mac, no server) ships per docs/get-started/install.md's "Other ways to install":
Mac tab (hero + closing, both said "A Mac-only setup is coming"), the FAQ "Do I need a server?",
and /start's intro + "What's coming" list all rewritten to say it's here, not coming. Left "What it
needs" alone — it correctly describes the recommended (server) path, doesn't claim Mac-only is
unavailable.

Did NOT add the brief's "pair your phone by scanning your avatar (Wink) at phone.vyre.run":
checked docs/work/launch-surfaces.md on work/launch (unmerged) and it's explicitly "Not started:
no relay.pair.ticket tool exists yet" there. Today's real flow (docs/using/first-hour.md) is a QR
code in onboarding; the page doesn't contradict that, so left it as-is. Flagged to team-lead in
case they want it held for Wink instead.

## Next

- 0.1.1 tags: swap the deployed Deck/phone sentence for the Wink wording already committed at
  a9fdabf7 ("scan your avatar at phone.vyre.run"), then `npx wrangler pages deploy` from
  work/site-copy. Until then bce49c81's "scan the QR code Vyre shows you" stays live.
- Screenshots from this pass are local-server only (localhost:8934/8935), not committed; re-run the
  usual CDP check on testbox against the live site if a fuller record is wanted.

## Deploy log

- caa157f7 -> deploy 170fab6b: headline, og.png, Mac-only-shipped fixes. Live.
- bce49c81 -> deploy 6f3ae2e2: "scan the QR code Vyre shows you" (Deck/phone section). Live.
- a9fdabf7: Wink wording ("scan your avatar at phone.vyre.run") in the same spot. Committed, NOT
  deployed — held for team-lead's go once 0.1.1 is tagged and phone.vyre.run is reachable.

## Needs from others

- None.
