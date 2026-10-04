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
- settingIntents wired in lib/said/hear.js (settings.schema keys at hear time); switchboard records kind it.kind and no channel for setting.
- S1 (Codex tools): found and fixed, proof passes on the test box (23 PASS 0 FAIL); runner run pending. Details in CHANGELOG.

## 2026-10-01 turn metadata and the one-turn route (work/assistant-turnmeta)
- Provider and model are on every reply event, reply item and threads_turns row (fields `provider`, `model`, model without the `[effort]` suffix). Notices carry neither. Grok's model is read from the prompt response `_meta.modelId`, Codex's from `_meta.quota.model_usage[0].model`. iq's recall_turns has the same two columns.
- Switch notice: "Switched to <Provider>. It has this session's memory and files." then, when true, "It starts from what was said so far, not from <From>'s own working notes." and "<To> cannot do these here: ...". thread.provider carries `{from, to, account, model, reason, text}`.
- Codex plan mode is an AskUserQuestion-shaped ask: question "Implement this plan?", header "Plan", options Implement (preview = the plan text) and Revise. Answer Implement allows once; anything else rejects.
- threads.send `{provider, account}` or an @ account chip (kind account, id `codex` or `codex:<account>`): person surfaces only. The thread moves to that provider for the turn (thread.provider reason "once", once true), the turn carries the handoff brief in front of the person's words, and when it ends the thread moves back (reason "back") and the next turn starts with a note of what was said. Refusals (code account_unavailable, out_of_usage, busy, open_elsewhere) say "Nothing was sent, and the turn did not move to another provider." An account that hit its limit here is refused for 30 minutes.
- Changed contracts: sessions module gains the `account` mention kind (search reach person, resolve reach modules). Switchboard calls artifacts.media.copy {id, thread} for each `#` artifact in a person's turn; a missing tool or a non-media item is ignored.
- Merged with work/sessions-reach: sessions' per-event provider/model/account tags are replaced by the live stamp (speaker: provider, model, account) on every reply event, so a one-turn switch is right line by line. threads.send takes only the account chip (no provider/account input). Init carries models and plan; thread.tool done carries exit_code.
\n- reviewer-2's two MEDIUMs on c3d4747a7 fixed: personTurn on the one-turn route; model replies quoted (`  | `) and labelled data in the return note and the handoff brief. Models are learned after sign-in (threads.providers.learn, internal).\n
- #41 (one model per turn): the thread's truth is what the provider reports per turn (speaker: live model, then the record). Fixed: init now moves the record and says model.switched once (reported: true); a live threads.model switch sets the live model so the next reply is stamped with it; the header, each reply and the picker all use shortModel. Root cause of the live miss: core/events delivered a listener's nested event before the outer one, and the SSE id cursor dropped the outer (model.switched lost to settings.changed); events now deliver in id order. Changed contract: core/events (re-entrant emits are queued until the current delivery ends), core/switchboard (model.switched also on init). Tests: switchboard "one model per turn", events "emitted by a listener", deck session.test header/reply labels.

## 0.3 (work/teammates-03, worktree vyre-assistant-03; the branch name work/teammates is the 0.2 line and is taken, so this is work/teammates-03)

Scope (lead, 3 Oct): project teammates on the `team` module (ADR 0031); memory in three layers; @Engineer. Built against kernel/contracts (work/kernel 0a2545d81, merged in). The kernel has contracts only so far, so every part is a factory over a `kernel` port (kernel/contracts `Kernel`) and is tested against `test/fake-kernel.js`, which keeps the rules the parts lean on (intersection of hops, placeholders to agents, one event per write, the task table, human-only approval, the inference door ledger).

Layout (no new boundary edges; shared pure helpers are in lib):
- lib/labels.js, lib/sealed.js: label joining (7.6) and the model view of a record (8.3).
- core/team/: roles.js (Kit role to teammate), delegate.js (grant ceiling and the adder's conditions as obligations, R6-8), context.js (project plus links minus sealed), doing.js (live "doing now" line), stuck.js (the seven triggers and the kernel-composed fix, R6-7).
- core/memory/engine/: lines.js (line-by-line session detail), facts.js (extraction, the three outcomes of 7.9), search.js (meaning search with per-source authorization and citations), index.js (the standing service, read-only, writes under [person, service:memory]).
- core/engineer/: propose.js (TypeScript definition via the model door, compile and simulate through ports, diff card), index.js (admin-only module).

Ports I need from others (asked in team/0.2/CHAT.md):
- platform: `tasks.move(chain, id, to, info)` and `tasks.stuck` on the kernel (the contract has only ask.request and ask.decide); `members.isAdmin(chain)`; a `memory` standing-service actor.
- records: `language.compile(source) -> { diff, errors }` (the TypeScript text form, 5.6) and the definition authorship label.
- sessions: `flows.simulate(diff, scenarios) -> result` and session events for "doing now".

Done (3 Oct): foundation 6827df3fb; core/team 27fb4d157 (roles, delegate, context, doing, stuck); core/memory/engine 0b8d77227 (lines, facts, search, scrub, index); core/engineer 99251017c (guard, propose, card, simulate, index). 201 of 201 passing on the test box with the docs, reach and boundaries tests (1 skipped), docs:check clean.
Doing: nothing running.
Next: wire the factories as module tools (module.json, reach classes) the day the kernel gateway lands and ctx.kernel exists; until then they are libraries with tests. Then: proposals as records (Engineer), perf numbers with scripts/perf-check.
Needs from others:
- platform (kernel): `tasks.move(chain, id, to, info)` incl. stuck (assistant or detection only) and the output-check moves; `members.isAdmin(chain)` and member/limited state; a kernel-built `[person, service:memory]` chain and `[admin, agent:engineer]` chain; a task payload that binds the proposal hash; the Engineer's grant set registered as a built-in; a `policy:` source grant for memory auto-accept; grants.create with parent must itself check containment and carry the parent's presence and approval conditions.
- records: `language.compile(source) -> { diff, canonical, hash, errors[{line,msg}], authorship, roles?, flows?, descriptions? }`; `fieldDef(type, field)` (kind, required) and `ownerOf(urn)`; reads of def.* through the gateway.
- sessions: `flows.simulate(diff, scenarios) -> { ok, steps, failures[{scenario,msg}] }`; confirm the thread.tool event shape and subjects for the doing-now line.
Changed contracts: none (new files only; lib/labels.js and lib/sealed.js are new).

### Components for native-core (core/work/native/component-kinds.js, components.js)
`toComponent(toolName, result, {types})` returns one plain, JSON-safe component; `assertComponent` is the closed validator (kinds closed, no functions, no sealed value or ref, no control or bidi characters, string caps). Anything unrecognised is a `text`. Every free-text field a doer or model wrote sits in a quoted block `{label, quoted:true, interactive:false, text}` with no links or buttons. Kinds and fields:
- `record_card`: type, title, urn, stage|null, fields[{name,label,kind,display,sealed?}] (a sealed field reads "on file, sealed" or "empty", never a value), hidden (count), source{trust,red,source_spaces}.
- `task_card`: id, title, record, doer, checker|null, state, output, tap{label,what}|null (what one tap does by state), payload_summary|null (the kernel's summary for a held act), from_doer|null (quoted block).
- `draft`: title, body (slots stay `{{slot:name}}`), editable:true, template{name,version}|null, to|null, merge_fields[{name,value}], sealed_slots[{slot,label}], edit_voids_approval:true (tapping Edit voids the approval).
- `flow_diff`: title, hash, authorship, changes[], simulation{ok,text}, outward[{text}], names[{name,shown,flags}], from_author|null (same shape as the Engineer's diffCard).
- `memory_answer`: text, citations[{address,label|null}] (urn or line:<session>#<n>), labels|null. An answer with no citation becomes `text`.
- `held_for_approval`: task|null, title, summary, approver, what ("Drafted and waiting for your approval. Nothing has left the Space.").
- `group`: title, items[component] (several records). `text`: text.
Needs from native-core: one renderer per kind. Needs from platform: the tool result shapes above (`held:true` with a task and summary for an outward act; records as gateway records with labels).

### Fit eval (scripts/eval/assistant-fit)
`evaluateModel({adapter, kernelFixture, budgetUsd=5, tasks, prices})`: five tasks (find, gate, seal, approval, cite), 20 points each, deterministic checkers over a fresh fake-kernel world, hard budget stop (the next call's worst case must fit under the cap, else the score is partial). Adapter shape `{name, run(messages, tools, {task,max_tokens}) -> {content, tool_calls, usage}}`; `adapter-claude.js` is the Messages API one. Real run: `node scripts/eval/assistant-fit/run.js --model <id> --yes --out <dir>` with ANTHROPIC_API_KEY set; never in tests. Needs: a per-model price table in run.js PRICES (unknown models use a high default); the model picker (native-core) reads the stored fit.

## 0.3 native assistant (3 Oct)
Done: situation, playbooks, tools-port 83dc06920; components 431ac11b5 and ec22b3f10 (contract in the "Components for native-core" section); fit eval. 224 of 224 pass (1 skipped) with boundaries, docs and reach on the test box.
Needs: platform generates the tool list from definitions as documented in tools-port.js, plus kernel.tasks.list, members.roleOf, a team-member read and the held-result shape in kernel/contracts; records: `playbook` and `team_member` types; vault: sign-off on the "why sealed" wording; native-core: one renderer per component kind and the picker reading the stored fit; someone: the price table (PRICES) in eval/run.js. No real model call has been made; a real run needs ANTHROPIC_API_KEY and the lead's go (about 5 dollars).

## 0.3 wired to the kernel (3 Oct, after the account switch)
Done:
- Merged origin/work/kernel (K1 to K4). Action names in my code are the registry's (`records.read`, `records.update`, `records.define`, `tasks.request`, `events.read`); the fake kernel uses them too.
- `kernel/tools/surface.js` (my branch, platform told so it lands once): the tool surface generated from the Space's definitions and the action registry, cut by the chain's grants. `<plural>.find|create|update`, `.move_stage` for a stage field, `tasks.assign`, and one tool per outward registry action. A tool the chain cannot use is not listed and a call to it is `not_found`. An outward act returns `{ held: { task, summary, approver } }` for an agent doer (the kernel makes the `sent` task with the approver as checker); a person's own act returns `{ needs_presence: { action, summary } }` (a person cannot check their own work, the kernel says `same_actor`). Sealed fields never appear in a tool schema. Tested on the REAL gateway and tasks (`test/real-kernel.js`).
- `core/work` module (`module.json`, reach on every tool): `work.tools|call|situation`, `work.team.context|add|doing`, `work.know.search|answer|suggestions|accept` (not `recall.*`: that name is Recall's), `work.engineer.talk|revise|approve`. Reads `ctx.kernel`; every tool answers `unavailable` until platform wires it.
- The fit eval now runs on the real gateway and the generated surface, with the kernel-built situation as its system text. `adapter-openrouter.js` and `run.js` use OPENROUTER_EVAL_KEY when set (the protected `eval` environment has only that secret). `.github/workflows/assistant-fit-eval.yml`: manual, environment `eval`, hard stop $5, key usage printed before and after.

Gaps for platform (what `ctx.kernel` must provide for core/work, all named in core/work/index.js):
- `kernel.chainFor(extra)`: the chain built from the call's own facts (no tool builds one).
- `kernel.definitions(chain)`: the Space's current type definitions (the store has `describe(type)` only; nothing lists types). `kernel.actions()`: the action registry.
- `kernel.grants.list/create/revoke` (teammates), `kernel.members.roleOf/isAdmin`, `kernel.tasks.list` (situation), `kernel.model.call` (memory answers, Engineer), `kernel.serviceChain("memory")`, `kernel.chainForPerson(person)`, `kernel.compile` and `kernel.simulate` (records, sessions), `kernel.fieldDef/ownerOf`.
- Stage gates (a stage's required tasks) are not enforced by the gateway; the eval fixture stands in for them.
- A person's own outward act: confirm `needs_presence` as the shape, or give a surface prompt for presence.

Blocked: the paid eval. The `eval` environment only allows main and work/stage-0.2 and a required reviewer, and a workflow must be on main to dispatch. Needs launch/lead: land `assistant-fit-eval.yml` on main (or add this branch to the environment's branch policy), then dispatch each of haiku-4.5, sonnet-5.5, gpt-6-sol and gemini-3.8-flash at budget 1 (the workflow lands on main with the 0.3 merge after reviewer-2; the user approves the run).
Next: first thing, run the eval once the workflow is dispatchable and record the run id here; then proposals as records for the Engineer; perf numbers with scripts/perf-check.

## 0.3 end to end with the Estate Kit (3 Oct)
Merged work/records (Estate Kit, language). `core/work/e2e-estate.test.js` runs on the REAL gateway and tasks (test/real-kernel.js): the Kit's nouns as tools, sealed SSN a placeholder to a model, a held send completed by the agent and approved only by the owner's presence proof (assistant and no-proof refused), the situation, a teammate added from the Kit's research role through delegateGrants, memory search and a cited answer authorized per source, and the Engineer compiling with the real language and applying under the admin's own proof.
Changed: the Engineer binds the card hash in the decision task's evidence (kernel.ask.start/complete) instead of `draft_hash`, which the kernel refuses; its grants are on `definition` and include tasks.work. Kit role grants (`{read|write|create: "type[.field]"}`) become wanted entries on `vyre://space/type/*`; a field-limited grant carries its fields on the add card, and the kernel grants by type, so field limits are NOT enforced (gap for records/platform). delegateGrants picks the parent by the kernel's selector rule; `grants.create` with `parent` must prove containment and the delegate condition.
Still a stand-in in the e2e: the model (scripted), grants.list/create and members (real-kernel.js ports), the compile adapter from the records language to the Engineer's Compiled shape (diff, canonical, hash). Not yet on a real Twenty store: the e2e uses the in-memory store; records' live Twenty run is theirs.

## 0.3 group chats: the situation is built for the audience (3 Oct)
Rule (DESIGN-chat, "An assistant in a group writes for the whole room"): `buildSituation(kernel, chain, { audience })` and the memory engine's `search/answer(chain, ..., { audience })` take the kernel-built chain of every person in the chat. With more than one person, a field arrives as a VALUE only when every viewer's own gateway read holds it with the same value; anything else arrives as `restricted here, cite it as {{field:<urn>#<name>}}` (a sealed field stays "on file, sealed"). A record some viewer cannot read at all is not shown, not even its name. Tasks, team and playbooks are the ones every viewer may see; "waiting on you" is left out of a shared room. Memory: a source is used only when every viewer may read it, record text is re-rendered from the fields they all hold (then scrubbed), and `withheld` counts what was left out so the model can say more exists. Tool calls still run under the asker's chain. One person in the chat is a one to one.
The room comes from the running session, never from tool input (reviewer-3 A-1): `work.situation`, `work.know.search` and `work.know.answer` call `ctx.kernel.audienceFor(extra)` and get `{ group: false }` or `{ group: true, chains: [kernel-built chains, asker included] }`. If `audienceFor` is missing, says nothing, or says group with fewer than two chains, the call is refused (`unavailable`); there is no fallback to the one to one view. The tools have no `chat` argument. An address that does not parse counts as withheld (A-3). Platform gap: `audienceFor`. Chat draws `{{field:...}}` per viewer.
Tested on the real gateway with a manager and a member whose grant carries a field allow-list: core/work/native/group.test.js (5 tests).
Gap, named: event-kind memory sources are gated per source but their text is not re-rendered per field; the index is built by the service chain, so a record's text is rebuilt per room at answer time, not stored per role.

Shape change (lead, after reviewer-2): no chain for another person leaves the kernel. `ctx.kernel.audienceFor(extra)` returns `{ group: false }` or a room handle `{ group: true, size, read(resource, fields?) -> { values, restricted: [names] } | null, canRead(resource) -> boolean }`. The kernel does the "every viewer holds the same value" comparison; core/work only renders: `values` as values, `restricted` as `{{field:urn#name}}` tokens, `null` or false as withheld or hidden. `buildSituation({ room })` and memory `search/answer({ room })` replace `audience`. Refusals, events withheld, the withheld count and tool calls under the asker's chain are unchanged. The tests use `roomFor(rk, chains)` in test/real-kernel.js as a stand-in for the kernel's handle. Shape to confirm with platform in CHAT.md.

## 4 Oct: core/work tests moved onto the real kernel (lead's job: fakes to real)
`test/kernel-rig.js` builds a Space with `createKernel` (real gateway, grants store, tasks, rule evaluator, room and chats) and nothing else: people get roles through `grants.setRole`, agents through `grants.addActor`, access through `grants.create` and `grants.narrow` (field allow-lists included), approvals through `ask.decide` with a proof. `test/fake-kernel.js`, its test and `test/real-kernel.js` are deleted. Files on the real kernel: memory engine (13), group audience (10), @Engineer (17), native situation and playbooks (8), team context (5), delegation (7), doing (5), stuck (13), Estate end to end (6), the eval fixture.
Still stand-ins, each labelled SHIM in the rig or the test and counted here (7): SHIM(model) the provider; SHIM(presence) the presence verifier (a headless test has no hardware signer); SHIM(note type) records' CORE_TYPES has no `note`; SHIM(tasks) `tasks.list` for an assistant chain answers the queue of the person it acts for, and `forRecord` (open tasks on a record) is derived from the log; SHIM(detect chain) the kernel's own detection chain for `observeDenial`; SHIM(compile) and SHIM(simulate) the language compiler and Flow simulator ports in the Engineer tests (the Estate end to end uses the real compiler).
Product bugs the real kernel found, all fixed: notes wrote the link field as a string; proposal tasks used a source and a `form` key the kernel refuses; auto-accept listed grants from a [person, service] chain (refused) so it could never turn on, now the kernel's own rule (a policy grant to the memory service); the write check was made on person-plus-service; `members.roleOf` and `isAdmin` take an actor, not a chain; the Engineer's explain read an event the kernel does not write (`definition.changed`), now `types.defined` plus `definitions`; narrowing read `grants.list` from a two-hop chain and compared role wildcards by hand, now `authorize` under the admin's own chain; an assistant acting for an admin counted as the admin; the Engineer's grants named `model.use`, not a registry action; the doing line, playbooks and team members read shapes records' real types do not have (`team-member`, playbook `name` and one `applies_to` text); `delegateGrants` sent `grants.create` with no presence proof and could pick a parent that cannot be delegated; the stuck watch counted denials the kernel already counts, and moved tasks as a service the kernel refuses (now `ask.stuck` as the doer, `observeDenial` for denials).
Not moved, and why: core/team/team.test.js (a real daemon, a fake claude driver, which is a provider stand-in), core/memory/personal/answer.test.js and site.test.js (0.2 modules that never call the kernel; a `projects.reach` stand-in). Moving them means wiring those modules to the kernel, which is not this job.
Platform asks (CHAT.md): `tasks.list` for an assistant chain and `tasks.forRecord`; a first-party detection door for a session host; a last-writer label on records (playbook review).

## 4 Oct: Capsule exception deleted, device rows on a real daemon
- Merged origin/work/kernel 90bbaa725 (PH-1, the Capsule's pinned-binary proof); pushed. The old capsule-exception test did NOT fail: it calls with the bare `capsule` label and no pin, and that call now gets no chain, as designed. So the exception is deleted anyway: `CAPSULE_EXCEPTION` and `whoOfCapsule` are gone, a Capsule call is the owner only with the daemon's proof (a `capsule` surface chain), and the bare label is refused (kernel-wiring.test.js, access-chain.test.js row "Capsule (pinned-binary proof)"). Its CUTOVER lines (H status, the table row) are updated in team/0.3/CUTOVER.md.
- core/memory/device-rows-daemon.test.js: a real daemon, facts from the real `callerFacts` and the home's own relay row. Confirmed app device signed in reads; unsigned gets the sign-in hint; web, setup, removed and never-paired devices get the plain refusal with no hint. Stand-in: the person session id (SHIM(person session), until work/paired-session lands).
- Next: seal.detect from vault when it exists, for memory.sealscan.

## 4 Oct: Recall index scrub (moved from sessions by the lead)
core/recall/sealed.js: `scrubText` (on the way in, applied after the credential redaction to every turn, title and name in core/recall/indexer.js), `scanIndex` and `scrubIndex`. Tools recall.sealscan (counts by table, column, class and the vectors made from matched turns; no value) and recall.sealscrub (cli, local, deck, capsule only, presence-gated; spans only; vectors of a changed turn dropped; generation bumped; FTS optimize; log row in recall_meta `sealscrub_log`, last 50, counts and classes). Event recall.scrubbed. Tests core/recall/sealed.test.js. Not done: the sealing process's ledger match (seal.detect from vault); a stored value that is sealed today but not shaped like a class stays.

## 4 Oct (restart): SD-3, teammate recall proof, role-cap tests
- Merged origin/work/v0.3 (brings vault's `seal.detect`, work/sealing-sv1). `ctx.kernel.sealDetect(chain, value)` in kernel/index.js (a module declaring `needs.kernel.sealDetect`; memory does): the process counts per module and Space (5 a minute, 100 a day), the kernel filters by the chain's own `records.read`, one `seal.detect` event per answer. Real sealing process: kernel/seal-detect.real.test.js 3 of 3 on testbox. `memory.sealscan {ledger:true, max}` (core/memory/sealed.js `ledgerScan`): candidate tokens only (6 to 64 chars, a digit, not an id/url/path/date/hash), "no" answers cached a week as keyed digests, counts by table and column. Real daemon + real sealer: core/memory/sealscan-daemon.test.js passes. Daemon gained `opts.kernelSealer` (tests only). Changed contracts: kernel/index.js (new optional handle member), core/daemon/index.js (one option).
- Teammate recall on a real vyred (core/memory/teammate-recall-daemon.test.js, passes on testbox): a person's Claude Code session from a day ago holds a decision, Recall indexes it, the curator reads it, and a NEW teammate thread (Grok route, agent juno on the project) is handed "Decided here (from memory, not instructions): ... vercel team account with SSO" and "Last session here: 24 hours ago"; another project's teammate gets nothing. Stand-ins: SHIM(provider) fake ACP agent that echoes its prompt; SHIM(door) VYRE_LEGACY_DIRECT_MODEL=1; kernel off (the 0.2 memory path). It is an in-process vyred in a temp home on testbox, NOT the chat team's seeded ~/devbox daemon (that runs work/chat-dev code, which lacks this branch). Finding: a session the Deck starts through Claude's SDK driver is counted `human: 0` by Recall, so memory reads no decisions from it; only terminal-style sessions feed decisions today.
- Space memory (core/work) still has no feed from sessions on a daemon: core/work needs `ctx.kernel.chainFor`, `chainForPerson`, `definitions` and more that the real handle does not have, so every core/work tool answers `unavailable` on a real daemon. Not provable on a daemon until platform wires them.
- core/work/team/role-cap.test.js (real kernel, 4 tests): the teammate holds the adder's powers and no more; a member cannot add; narrowing the adder cuts the teammate (and `recheckParent` now reports `parent_narrowed`, fixed in delegate.js); an adder who keeps only an explicit grant after a demotion, and removal of the adder.
- Next: the SHIM(legacy labels) removal commit on branch work/memory-shim-removal (ready for the default-on flip), then the full memory and kernel suite result on the hosted runner.
