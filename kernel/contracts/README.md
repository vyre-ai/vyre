# @vyre/kernel-contracts: the studs

Types and constant tables for the Vyre kernel. No logic. Every team builds against these, and
the kernel implements them. Source of truth: `team/0.3/SPEC-core-contract.md` (the contract) and
`team/0.3/KERNEL-brief.md` (the ten invariants).

| File | What it freezes |
|---|---|
| `chain.d.ts` | the actor chain (built only by the kernel), the verified surface facts, the presence proof |
| `authorize.d.ts` | `authorize` input and output, obligations, reason codes, the action registry entry |
| `grant.d.ts` | grants, selectors, conditions, the `grants` calls |
| `event.d.ts` | the event envelope, intents, checkpoints, the `events` calls |
| `store.d.ts` | the store interface and its data types (what the conformance suite tests) |
| `task.d.ts` | the task record, states, outputs, transition rules, `ask` calls |
| `fields.d.ts` | field kinds, values, type definitions, and the field-renderer props for the UI |
| `model.d.ts` | `model.call`, the single inference door |
| `seal.d.ts` | `seal.put`, `seal.use`, `seal.reveal` |
| `gateway.d.ts` | the gateway's record calls and the assembled `Kernel` |
| `index.js` | frozen constant tables (enums, the task transition table) |

Rules for changing a stud: additive only, one commit, and tell the lead; a removed or retyped field
breaks every team that built against it.
