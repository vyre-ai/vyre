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
- 2. memory.write and provenance: ce39b7f2 (ctx.memory.write in the loader), 3bba435a (tables,
  tools, reads, tests in core/memory/write.test.js).

## Doing
- 1 and 2 dispatched in parallel (1 touches scripts/ and test/ only; 2 touches core/memory).

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
- Kernel (core/modules/index.js): ctx.memory.write(row) checks row.kind against teaches.memory and
  calls memory.write as module:<name> through the loader's door. ctx.memory.teach unchanged.
  packages/module-sdk: index.d.ts write() is no longer @planned, project required, returns
  {id, linked}; the testing fake returns linked: false.
