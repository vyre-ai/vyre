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
(none yet)

## Doing
- 1 and 2 dispatched in parallel (1 touches scripts/ and test/ only; 2 touches core/memory).

## Next
- Review 1 and 2, then 3.

## Needs from others
- sessions: the vyred caller rule (P2), threads.quick {provider, account, model, maxUsd, stream},
  threads_items, threads.said for ACP threads.
- integrator: stage/0.2; a memory-eval workflow on hosted runners with recording credentials.
- user (via the lead): $15 of eval recording, O12, throwaway provider accounts.

## Changed contracts
(none yet)
