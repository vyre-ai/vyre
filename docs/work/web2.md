# web-2: Deck parity in the Expo app (stream notes, 5 Oct 2026)

Branch `work/web2` (the one merged app head: work/web + app-wire + web2, on trunk f9d050c8f). Folder-privacy server work: `work/web2-privacy`.

Done and in the head: Memory (Lessons, Sites, "Where this came from"), Vault (Passes, Shared, Devices, Health, History, Change, SSH), Connections at /u/connections, Find at /u/search and Cmd-K (`FindHost`, Drive and chat file names), the shared expression rules in `lib/expr`, the Glass and xterm assets moved to `apps/app/vendor`. Glass (Screen Share) is hidden for 0.2.9 (`RC.glass = false`); its code, `src/glass`, `vendor/glass` and `glass-assets.mjs` stay for 0.3.1. Checks on 9e94b9f56 (testbox2): check-ui-imports 0, tsc clean, app suite 1047/1047, export:web ok, docs tests 61/61.

Folder privacy (`work/web2-privacy` f22784f76, on work/hub-kernel-on + work/one-chat): `files.drive.space.search` (names only, kernel decides, participants' chats included), chat files never made public links and re-checked on every open. Tests: core/files/space-privacy.test.js and space-privacy-live.test.js (19/19).

Open items: swap `chatsOf()` in core/files/space-drive.js to chat's `chats.mine(chain)` once chat sends the sha (then re-run space-privacy-live); core/files/space-drive.test.js test 4 (4 versions where 3 expected) fails on trunk too, not mine; scripts/gen-allow.mjs lacked a FLOWS_NOTES line for flows.budget on hub-kernel-on (fixed on platform-3's work/golden), my allow.json entry for the search tool was added by hand; Find has no 0.3.1 Glass command by design; walker's finding 2 (raw spc_ id in the workspace chip) is the shell's.

Next exact step: when hub-kernel-on and chat's `chats.mine` land, merge origin/work/web2-privacy into trunk, swap chatsOf(), run `node --test core/files/*.test.js` on a testbox, and regenerate docs with `npm run docs:ref`.
