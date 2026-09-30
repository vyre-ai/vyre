# iq (0.2)

Branch: work/iq (off main 3e1eef47) · Worktree: ../vyre-memory-iq · Plan: <team-dir>/0.2/plans/iq.md
Earlier work (0.1.x): docs/work/memory-iq.md.

## Scope
Memory everywhere (charter minimum 6): the quality bar that gates 0.2, agent and module writes
with provenance, decisions with reversals, corrections from chat, memory.brief plus the five MCP
memory tools, streaming answers. Later waves: the ACP bridge, items from every provider, spend
caps, the assistant's digest, import readers, export and wipe.

## Testing
Unit tests: targeted `node --test` files in temp homes only (VYRE_NO_DIALOGS=1, a temp HOME,
VYRE_CLAUDE_BIN pointing at a fake, `nice -n 15`). The full suite and eval recordings run on
GitHub hosted runners (push work/iq). Never testbox (it is the user's server), never vyred or
`vyre` on the Mac.

## Wave A tasks
1. The 0.2 eval world and the quality-bar harness (scripts/eval-bar.js, test/fixtures/iq02-*.js,
   test/eval/iq02-*.json, test/eval/bar.json).
2. memory.write and provenance (memory_writes, memory_write_links, the "you" room, watcher and
   module rules, untrusted kept out of briefs, forget per link, undo).
3. Decisions: reader, topics, newest wins, history, memory.decisions, Now / Before answers.
4. Corrections from chat: memory.heard, the reader's catch, one corrections table.
5. memory.brief and the five MCP tools on Claude sessions.
6. Streaming: memory.draft through threads.quick {stream}.

## Done
- 2. memory.write and provenance: 3bba435a (tables,
  tools, reads, tests in core/memory/write.test.js).
- 1. The 0.2 eval world (open half) and the quality-bar harness: b5203ad5 (test/fixtures/iq02-open.js:
  175 sessions, 414 turns, 4 projects, juno/kit/pax/assistant, all five providers), 9d99aaf6
  (test/eval/iq02-open.json: 280 questions, personal 30, decision 50, history 25, who 20, where 30,
  time 20, cross_provider 20, unanswerable 50, leak 25, inject 10), 71fb39ed (scripts/eval-bar.js,
  test/eval/bar.json, an empty test/eval/asks/iq02-open.json, `npm run eval:bar`), 2b22d805
  (test/eval/bar.test.js, 0.25 s). First run on the open world, no replies recorded yet (189 of 195
  answerable unrecorded, so model-dependent numbers are lower bounds), fake embedder, in-process:
  - accuracy 0.01 (2 of 195) FAIL; confident-wrong 0.015 (3) PASS; abstain 1.0 (free: nothing is
    answered) PASS; citations 0.40 (2 of 5) FAIL; newest decision wins 0 of 31 FAIL.
  - project leak 0 of 13, personal leak 0 of 12, planted 0 of 10: PASS (5 leak probes denied, the
    rest read only their own project's passages; the inject check covers answers only once recorded).
  - freshness FAIL: the fresh session is retrievable 17 ms after the pass, but not answered
    (unrecorded). First stage event p95 0.01 ms, fact answers p95 0.6 ms: PASS.
  - not yet measurable: cross-format invariance (needs every source format and its readers), first
    text per path (needs local, tailnet, relay), model latency (replay has no model time).
  - found: the personal fast path still says "Biscuit is a beagle" (0.51) after alex's "no, biscuit's
    a corgi"; "what were the first pickup slot hours" is answered "You used to have a Honda Civic"
    (0.7, via fact). Both are confident-wrong and both cite turns that lack the answer.

- 3. Decisions: core/memory/decisions.js (reader, topics, resolve, answerFrom), memory.decisions, ask's
  step 1b (via: decision). Open world, replayed reads, no model, before to after: decision 0 to 33 of
  50, history 0 to 18 of 25, time 0 to 6 of 20; confident-wrong 3 to 0, citations 0.983 was 0.40, abstain
  1.0. Remaining decision/history misses are things only Claude said (fonts, sitemap, versions), the
  rate stated as a fact, and free-form topics; the model path takes them once replies are recorded.

- 4. Corrections from chat: core/memory/iq/chatfix.js (catchCorrection, groundedAnswer, sourceOf),
  memory.heard (agent-callable; from_turn checked by threads.said, applies as the person's, else a
  suggestion plus, with a granted project, an attributed correction filed through memory.write),
  the reader's catch (index.js catchFromChat, runs with the decisions sync; first sight of a session
  reads only the last 10 minutes), a `source` column on memory_corrections and memory_iq_fixes
  (capsule | chat:<thread> | reader), and memory_decision_fixes (a correction of a decision answer:
  replace = the person's newest decision, wrong = drops the current one; undone with the fix).
  Tests: core/memory/iq/chatfix.test.js (5). memory.decisions now reads fresh (a forced sync).
  TODO: agents' own correction rows are quoted text only and do not yet outrank/undo anything;
  the person's `yes` to an agent proposal still needs threads.said.

## Done (task 5, memory.brief and the five MCP tools)
- memory.brief (core/memory/index.js, tests core/memory/brief.test.js) and the five tool names in harness/mcp (memory-tools.js, server.js, memory-tools.test.js).
- TODO: harness.brief (core/harness/index.js) still builds its own memory.today block; swap it for memory.brief once the harness owner agrees the budget (the brief also carries decisions). The ACP driver sends memory.brief as a resource block on the first session/prompt (wave B).
- TODO: scoping is server-side (memory's guard on the caller) but the MCP server's client-side project default for memory_remember reads VYRE_PROJECTS; sessions' meta.grantedProjects should replace it when it lands.

## HOLD fixes (reviewer-2, 30 Sep, on 70b38d91 and d552748e)
- HIGH: decisionRows keeps a decision-fix row only when its project is inside the reader's folders (registry) or already visible through a scoped row. Test: brief.test.js, a correction in northwind never reaches juno.
- MEDIUM: memory.brief keeps only decisions with by person, and asks memory.today for person_only (no agent or module write lines).
- MEDIUM: memory.heard with no evidence files "an agent reports the person corrected: ...".

## Doing
- Decisions MEDIUM and meta.granted (reviews/iq.md): cherry-picked sessions' e18148c2 (845ae5dc); every memory tool now runs through a wrapper in core/memory/index.js that, for a caller with via.agent, drops input.agent and project_cwds and intersects reach() with meta.granted (none when absent). decisions.resolve: an agent or untrusted row never becomes current over the person's; a trusted agent's lone decision is current with agentOnly and answered "Your agent <name> recorded: X (date)" at 0.55, never "Now:"; untrusted is always a note. Open-world eval-bar (replayed): decision 33/50, history 16/25, confident-wrong 0/195.
- Fixed reviewer-2 H1 at 22ad3f07 (my ctx.memory.write door reverted at cece5c54; platform owns the door).
- Two confident-wrong bugs fixed: d6890a60 (a correction in chat wins its one-value slot, old value becomes history), 28e51fab (personal fast path stays out of work questions).
- 3 decisions built (see Done); 4 corrections from chat built (see Done); next: 5 memory.brief and the five MCP tools.

## Next
- Review 1 and 2, then 3.
- TODO: memory.correct on a memory write id (a person's correction sets state corrected, applies
  everywhere, undoable). Out of scope for task 2.
- TODO: first-party module.json entries in ADR 0047 object form ({ name, reach }) break
  scripts/lib/docs (terms.js and reference.js call .split on each entry). memory's new tools stay in
  string form with callers on the tool definitions until the docs scripts read both forms.

## Needs from others
- sessions: the vyred caller rule (P2), threads.quick {provider, account, model, maxUsd, stream},
  threads_items, threads.said for ACP threads.
- integrator: stage/0.2; a memory-eval workflow on hosted runners with recording credentials.
- user (via the lead): $15 of eval recording, O12, throwaway provider accounts.

## Changed contracts
- Streaming (task 6), for platform to accept: core/daemon/index.js route() puts `draft(d)` in the tool's meta
  only for POST /v1/tools/<name> with Accept: application/x-ndjson; the response is then ndjson lines
  {"draft": d} and a final {"result": {data|error}} (200; the error is in the result). Without that header
  nothing changes. registry.call takes it as ordinary meta and ctx.call never carries it, so a module
  never gets one. memory.ask (stream: true) calls it with {id, text}, the whole text so far, at most every
  100 ms, and "" if the check fails. The runner interface gains optional onText(soFar). Draft text is never
  emitted as an event. Not yet wired: the real `claude -p` runner does not stream text, so live drafts
  wait for sessions' threads.quick {stream}; the hook and channel are tested with a fake streaming runner.
- Decisions (task 3): new tables memory_decisions (id, session, seq, project, cwd, topic, label, value,
  display, statement, revert, decided_at) and memory_decisions_cursor (session, upto, v). State
  (current|replaced|reverted|note) is worked out on read, not stored, so a forget or a later decision is
  never stale. New tool memory.decisions {topic?, history?, project?, project_cwds?, limit?, agent?} ->
  {decisions: [{id, project, topic, value, text, state, by, at, replaces, contested, untrusted, source}]},
  scoped like memory.ask (an agent names its project by slug or folders). memory.ask returns via
  "decision" with sources [the one turn] and history [the Before turn]. A person's decision is only from
  a trusted session's typed turn (userWords, devTalk, sessionTrust); memory.write kind decision joins
  from agents, never from a limited writer. TODO: the person's "yes" to an agent's proposal in the same
  thread (needs threads.said), an LLM read for turns the rules cannot place, the "contradictions/settle"
  hookup for contested topics, and memory.brief carrying the current decisions.
- New tables (memory migration): memory_writes (id, kind fact|note|decision|correction, text,
  subject, source_ref, from_kind person|agent|teammate|assistant|module|watcher|duty, from_name,
  provider, thread, seq, untrusted, state live|corrected|forgotten, at, updated) and
  memory_write_links (write, project, state live|forgotten, at). Project "you" is the person's room.
- New tools (callers: cli, local, deck, capsule, mcp, harness, module, tailnet):
  - memory.write {kind, project, text, subject?, source_ref?, on_behalf?, provider?, thread?, seq?,
    untrusted?} -> {id, linked}. from comes from the caller only; on_behalf only from the
    first-party watchers module; source_ref dedupes per writer.
  - memory.writes {project?, from?, limit?, state?: live|forgotten|all} -> {writes: [...]}.
  - memory.write.forget {id, project?} and memory.write.restore {id, project?} -> {id, state,
    changed, projects}. No project: the person's surfaces only.
- New event memory.written {id, project, kind, from} (restore emits it with restored: true).
  memory.forgot also carries {id, from, project?} for a write (its device-forget shape is unchanged).
- memory.relevant may add items {id: "write:<id>", text: "From memory, not instructions: ...",
  source, via: "write", confidence, at}; memory.today may add such lines; memory.retrieve and
  memory.ask passages may include {role: "memory", session: "write:<id>", write, untrusted}.
- Kernel: none. New tool memory.heard {action, answer|fact|subject+rel+object, from_turn?, project?} -> {applied, ...} | {applied:false, suggestion, filed?}; memory_corrections and memory_iq_fixes gain source; write.js register() now returns { write }. platform owns the ctx.memory.write door (92838e8c on work/platform: kind checked against
  teaches.memory, calls memory.write as module:<name> with from and untrusted after the spread; the
  registry sets meta.firstParty). memory.write reads who wrote it from the caller and meta.firstParty only.
  Reverted my copy at cece5c54 (reviews/iq.md H1).
