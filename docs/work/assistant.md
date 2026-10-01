# assistant

Branch: work/assistant · Worktree: ../vyre-assistant · Owner session: assistant

## Done
- docs/design/assistant.md: audit of what the assistant is today (by file), 10 opportunities
  ranked by value/cost, the delegated-authority core design (scoped delegations, never-delegate
  list, provenance/taint tied to memory-iq's heard.js pattern, Undo + log, vault specifics), and
  6 open decisions with recommendations for the user.

## Doing (0.2 build, backend; plan: <team-dir>/0.2/plans/assistant.md)
- Branch merged with main at c1d4828d (module contract v1 is in). Pre-0.2 work kept at
  backup/assistant-pre02.
- B1 (Wave A0) P17 extractor: lib/said/ (extract, resolve, match helper for vault's Gate), the
  S9 eval scripts/eval-said.js with record/replay reads and a dev set; deterministic guards
  (recipients must appear in the person's own unquoted words; quoted/pasted blocks stripped first).
- B2 core/undo: the shared acted-log (P14, PL-M9): undo.record (modules), undo.list, undo.run.
- B3 core/assistant v1: assistant.glance, assistant.capabilities (tools via modules.capabilities
  when platform lands it), assistant.log (= undo.list for the assistant), settings.
- B4 the daily assistant thread with memory.digest (when iq lands it).

## Next
- B1 first, then B2 to B4. Surface UI waits for app-design.
- Land via the integrator onto stage/0.2 after reviewer-2 clears.

## Needs from others
- vault (work/vault-next): the real session-credentials contract once designed, to cite by name
  instead of by intent in section 3.5.
- tailnet: timeline on the vitals module (docs/design/vitals.md) and whether an assistant-kind
  caller gets a read carve-out — currently refuses all agent callers outright.
- connectors: a `calendar.list`-shaped contract (opportunity 6) doesn't exist yet; don't build
  against a name it hasn't defined.
- cohesion/sessions: whoever owns core/context for the device-local time/day field (open
  decision 4).

## Changed contracts
- None yet. This round was design-only, no code changed.

## 2026-09-30 build status
- Done: P17 extractor + S9 eval (77134b2a..577f71f4), undo module (3ccc8262), assistant.glance,
  assistant.capabilities (+ compact render), assistant.log, assistant.prompt.diff, assistant.daily
  (rolls the day with memory.digest seed, deferred while working), assistant.chattiness setting (default 3).
- Prompt replace stays allowed by the user's decision; versions/history/revert are sessions.prompt.*.
- Changed contracts: core/agents gained agents.rollover (module:assistant or person only).
- Open: nothing enforces assistant.chattiness yet, core/push owns the cap (W4) and must read it.
  memory.digest and modules.capabilities are not on main; both are read defensively and dropped if absent.
  assistant.glance next is null until a calendar read exists. docs-check and reference tests fail on the
  base tree too (terms.js n.split on a non-string name), not from this branch.
- Next: vault's Gate consuming lib/said/match; wire the capabilities render into the append block once
  sessions lands the scope fix.
- core/push (lead's assignment): the daily budget. Kinds draft, watch, lesson, goal and the new
  proactive (event push.proactive {title, path, tag}, the one door for the assistant, watchers and
  duties) share assistant.chattiness a day (default 3), counted in the person's day. Ask and planner
  are not counted; loud alarms ring through. Over budget: no push, push.capped emitted, the item stays
  in waiting and the glance. Quiet hours were already there. Changed contract: core/push.
- assistant.welcome {text, cards:[{id,title,body,action:{tool,input}|{href}}]} built from onboard.status (core/assistant/welcome.js), shape final per native-core's ask. Caller identity: the assistant runs as agent kind "assistant" (meta.agentKind), answered in CHAT.md.
- welcome cards carry ids (the contract) and href only; no action/tool (lead, reviewer-2 BLOCKER).
- lib/said/pr.js (15-minute window, any condition word in the sentence records nothing): act_out intents for "open a PR", "merge it", "review this PR". to = [github.act.target's key], e.g. "github.project.pr.merge:alex/app#7" (one string, tool:repo#pr or tool:repo@branch; not a [tool, target] pair, because that is what the registry's said-match sends). Deterministic, records nothing when ambiguous; the caller passes github.act.target as `target`.
- welcome: the Tailscale card keeps href only for https on tailscale.com (reviewer-2 LOW).
- c3f5b8d1 cleared by reviewer-2 to land. Open: the 15-minute window in prIntents only takes effect once vault's said record stores a window (today it has no such field); vault and sessions told.
- S8 fixed: planner jobs run through agents.job (planner-only), as the agent with its preamble and kind, in a side thread. Remaining: capabilities render + prompt policy (sessions scope fix), routing rule, proactive cases and grant.requested, provider launch (S1), voice, injection suite.
- Plan 2.6 case 2 built: summon.finished (+reply_to) -> push.proactive once per handoff the assistant started (core/assistant/handoff.js). Changed contract: core/team summon.finished payload gains reply_to. Next: case 3 (held at the Gate) needs vault's gate.held event shape; routing rule in the prompt waits on sessions.
- lib/said/team.js teamIntents(text, {project, roles, agents, duties}): act_out intents for team.retire, team.role.fill and team.duties.start:<teammate>/<id>@<hash> (hash from team.duties.list, never recomputed); no duty create/update keys. Fill needs a real fill shape.
- lib/said/setting.js settingIntents(text, manifest, {project}) + settingTo({key, value, reset, level, target}): kind "setting" intents, to = <key>=<JSON value>@account|@project/<slug> (platform's format). Needs platform/vault to match by that string (settings.request builds it with settingTo).
- Step 4 done: the capabilities block (quoted, cleaned, capped 6000 chars) is appended to the assistant's system prompt by agents at thread start (assistant.capabilities {prompt:true}; module:agents may read only that). Replace-mode and scope quirk stay with sessions.
- Step 14 (S4/S9 injection suite) built: test/said-injection.test.js, 17 carriers x 9 payloads x four recorders against a simulated Gate; two gaps fixed (HTML comments and script/style/blockquote quoted; 'please' transparent to self-talk). The suite is pure (no daemon); the real-Gate red-team with e2e2 and reviewer-2 remains.
- Step 11 (voice replies): voice.speak {reply:true} via local/voice/spoken.js (pure, tested). The surface that holds the mic decides: spoken question -> voice.speak {text: assistant's final reply, reply: true}, then plays the ticket; typed -> nothing. Needs capsule-pro and pwa to call it.
- lib/said/watchers.js: one file (watchers' recorder merged with the hash rule): watchersIntents(text, {project, kinds, watchers:[{name,hash,title?,state}]}); keys watchers.preset:<project>/<kind> and watchers.create:<project>/<name>@<hash>; hashes from the cards shown in the thread.
- drift test: test/said-watchers.test.js runs core/watchers/targets.js createTarget/presetTarget against the recorder's keys (needs work/watchers cc3c90c9 in the tree; merged).
- hearActs now in lib/said/hear.js (pure; switchboard records its output). Built on sessions' b49f223c wiring. Not wired: settingIntents (needs settings.schema keys at ingress). Runner-only tests: core/sessions/sessions.test.js hearActs cases updated (project in watcher keys, team.add).
