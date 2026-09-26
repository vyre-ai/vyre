# memory-iq

Branch: work/memory-iq · Worktree: ../vyre-memory-iq · ADR 0023 · Owner session: memory-iq

## Scope

Memory that knows the user. Today "name of my wife" returns unrelated quotes and "which car do I
own" works only when one literal sentence matches. This workstream adds:

1. Personal facts: durable subject-relation-object facts about the user and the people and things
   in their life, extracted from every session's user turns, incrementally and in the background.
2. `memory.answer {q}`: one answer line with confidence and "from N conversations", sources on
   demand. Fact lookup first, then meaning (recall with embeddings), then keywords.
3. An eval harness on a synthetic world, run in CI.

Files owned: `core/memory/personal/*` (new), `scripts/eval-answer.js`, `test/fixtures/personal-world.js`,
`test/eval/answer-*`. Small, listed changes in `core/memory/index.js`, `core/memory/schema.js`,
`core/memory/module.json`, `core/cli/commands/memory.js` and the status command.

## Design (the contracts every task builds against)

### Storage (memory's store, one new migration in core/memory/schema.js)

- `memory_me_claims (session, seq, ts, subj, rel, obj, conf, method, PRIMARY KEY (session, seq, subj, rel, obj))`
  what one user turn says. Rewritten transcript: drop the session's rows and re-read it.
- `memory_me_cursor (session PRIMARY KEY, upto, at)` how far each session has been read.
- `memory_me_entities (id PRIMARY KEY, kind, label, first_seen, last_seen)`
- `memory_me_aliases (alias, entity, PRIMARY KEY (alias, entity))` lower-case forms that name it:
  "my wife", "wife", "jordan".
- `memory_me_facts (id PRIMARY KEY, subj, rel, obj, obj_label, confidence, first_seen, last_seen,
  mentions, sessions, current INTEGER)` derived from claims on every pass; never hand-edited.
- `memory_me_evidence (fact, session, seq, PRIMARY KEY (fact, session, seq))`
- `memory_me_budget (day TEXT PRIMARY KEY, usd REAL, calls INTEGER)` the model pass's spend.

### Claim references

`me` (the user), `kin:<role>` (an unnamed singular relative: kin:spouse, kin:mother), `name:<Name>`,
`lit:<text>` (a literal value: a date, a place), `vehicle:<Make Model>`, `place:<Name>`, `org:<Name>`,
`tool:<name>`, `pet:<name>`.

### Relations

People: `spouse`, `partner`, `mother`, `father`, `child`, `son`, `daughter`, `brother`, `sister`,
`pet`, `friend`, `colleague`. Singular roles (spouse, partner, mother, father) resolve to one
entity: "my wife", "Jordan" (once "my wife Jordan" is said) and "her" in the same breath are one.
Attributes: `name` (me|name|lit:Alex, kin:spouse|name|lit:Jordan), `birthday`, `lives_in`,
`from`, `works_at`, `role`, `owns` (vehicles and other things), `drives`, `client`, `uses`,
`prefers`.

### Confidence

Per claim by method: explicit rule 0.9, indirect rule 0.7, model 0.75, assistant's words 0.35.
Combined per fact as 1 - prod(1 - c), then scaled by its share against rival values for a
single-valued relation (a spouse's name, a birthday, where the user lives: newest wins ties).
memory.answer answers at confidence 0.5 or more, says "maybe" from 0.3, and says nothing under.

### memory.answer

Input `{ q, project_cwds?, room?, sources?: boolean }`. Output
`{ answer: string|null, confidence: number|null, kind: "fact"|"said"|null, from: number (conversations),
   facts: [{ id, subject, rel, object, confidence, sessions, first_seen, last_seen }],
   sources: [{ session, seq, name, quote, ts }], via: "fact"|"meaning"|"keyword"|null, ms }`.
Callers: the user's surfaces (deck, cli, local, capsule), the user's tailnet devices, modules, and
the assistant or an agent granted every project. A project-scoped agent is refused: personal
facts are not a project's.

## Done
- (none yet)

## Doing
- T1 eval world + harness (before score), T2 extraction + store

## Next
- T3 model pass with a daily cost cap shown in vyre status
- T4 memory.answer, CLI `vyre memory ask`, CI step
- T5 ADR 0023, CHANGELOG, contract to capsule-pro, pwa, mobile

## Needs from others
- polish-cli: the contract of the low-priority index worker. Until then extraction runs in the
  memory curator's background pass, in bounded batches that yield.

## Changed contracts
- New tool `memory.answer` (see above). New table family `memory_me_*` (memory's own).
