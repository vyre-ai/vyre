# web

## RESUME 5 Oct: the one app in the browser
- Lead ruling 5 Oct: the Deck stays the default at / until every row of team/0.3/PARITY-deck-to-expo.md is ported and walked. Cutover to the Expo app at / is behind `config app.root`.
- DONE: apps/ios and apps/android deleted (827092024). The daemon serves the app at / when `app.root` is on AND the export was built for the root (`npm run export:web:root` in apps/app: VYRE_APP_BASE=root, precache.json carries `base`). An export built for /app/ never serves at / (the Deck answers). The box's own paths (/onboard, /person, /release, css, js, vendor, fonts, icons, /kernel, /lib, /v1) stay the box's. The worker and manifest take their base from the export (core/daemon/app-sw.js BASE).
- NOT done: deleting deck/ (parity not there, see the PARITY file); the release pipeline building the root export (one dist, one signed appbuild.json: when the flip lands the release builds with export:web:root and nothing else in signing changes).
- Where the Deck's shared code lives today: apps/app imports deck/chat/core, deck/ui and deck/vendor/vyrecode by path (metro aliases @vyre/chat-core and @vyre/deck-ui). They move out of deck/ at the flip, not before.
- PORTED from the Deck (5 Oct, tests on testbox4): AI accounts, Spending limits, Standing permissions, Connections (servers, Google, GitHub; adding is not), Planner. List and what is left: team/0.3/PARITY-deck-to-expo.md.
