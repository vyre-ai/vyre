# platform-3

Branch: work/kernel-declare (off work/kernel-reg bc6da3c96) · Worktree: ../vyre-platform3 · Owner session: platform-3

## Scope
Two jobs taken off platform. (1) What the registry defaults on work/kernel-reg break: run the suites on a test box, list every broken caller by owning team with the fix. (2) Declarations: `effect` on every tool, and a `callers` list wherever the body shows who may call a state-changing tool open to anyone. Lower the FROZEN count in test/registry-default.test.js with each batch.

## Done
- All 935 non-internal tools declare `effect` (manifest entry where it is an object, ctx.tool def where it is a string entry): FROZEN 906 to 4 (the four tools the test registers itself). One commit per module.
- Callers added or tightened where a body showed who calls it (see CHANGELOG and the per-module commits). Audit fixes inside: HD-1 onboard personOnly, HD-2 threads.start allow-list, HD-3 link.call origin, HD-4 harness.enrich, HD-5 hands resolveAgent, HD-7 session push/undo/redo own session, HD-9 agents.ask project cap, HD-10 charter draft/revert, memory.retrieve knobs.
- Suite run on testbox4, 640 files, one process per file: kernel-reg 534 pass 106 fail.

## Doing
- Nothing running. Owners hold their DESIGN CHOICE lists (team/0.2/CHAT.md, "platform-3 -> platform ...").

## Next
Re-attack by reviewer-2 on dca63a3fc; platform merges work/kernel-declare into work/kernel-reg. Then HD-6 (consequence guard to a safe set), HD-8 (pending remembered facts) if no owner takes them.

## Needs from others
Owners: DESIGN CHOICE items in CHAT.md. platform: the testbox socket-label stall (test/cli #6, recall module #5).

## Changed contracts
None. Effect is read from the manifest entry or the ctx.tool def (already supported by the registry); callers stay in code. Tools that need a module hop to work for an assistant list `module` explicitly (threads.lease).

## 4 Oct (resume)
- RC-1 done (9c1725111): daemon builds a model's label from verified parts (`modelLabel`, lib/caller.js). The unverified mobile WIP was reverted (9ac286958); redo as item (c).
- Plugin grant (ruling a5ad6b9): core/pluginagent (ask, status, pending, grant, revoke, vouch), daemon route (key check, plugin kernel token stamped by vyred, label stays bare `mcp`), harness/mcp/server.js (reads plugin-agent.json, asks once). Test: core/pluginagent/pluginagent.test.js (real daemon, the real server over stdio).
- Next: (c) person-surfaces list; (d) write-tool sweep. Needs: ui-ux (approval card and Access copy for `pluginagent.pending`/`pluginagent.asked`), assistant (plain "not granted" sentence in the plugin; their recall refusal of bare mcp), a CLI sugar `vyre plugin grant` if wanted.
- Changed contracts: daemon route accepts a plugin agent's key where it accepted only a thread's; agents `personal` flag cherry-picked from work/memory-access.
- Sweep (d): test/plain-session-writes.test.js + .json. 132 write tools reachable by a plain session; classes: refused 60, own 48, held 14, hook 5, review 5 (owners: vault generate/request/ssh.generate, files fetch, github project.local-init). The 'held' mail/google ones rest on their own tests (held at the Gate); a fake-account hold test is still open.
