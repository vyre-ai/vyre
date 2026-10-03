// @ts-check
// deck/ui/contracts: the Deck's view of the kernel's frozen contracts (kernel/contracts/*.d.ts), as JSDoc aliases and the one Store interface the generated
// screens read. No code runs here. The kernel's types are the types: a record is a GatewayRecord, a task is a kernel Task whose doer, checker and assigned_by are
// Actors, a field's value is a FieldValue, an event is an EventEnvelope, a sealed value is a SealedRefValue and never plaintext. This file adds only what the
// kernel does not have, and says so ("UI-side").
//
// HOW A GATEWAY ADAPTER MAPS (deck/ui/gateway-adapter.js is the one file that does it; ui/store.js picks it or the mock in one place):
//
//   Store call                      kernel call(s)
//   ------------------------------  ------------------------------------------------------------------------------------------------------------------------
//   types(space)                    the type definitions of that Space's gateway (records.define's result, read back); one gateway per Space, merged on the device
//   list(type, { filter, sort })    records.query(chain, type, { filter, sort, page }) following next_cursor, per Space, merged (SPEC-core-contract.md 10.6)
//   get(urn)                        parse the urn (vyre://<space>/<type>/<id>), records.get(chain, type, id)
//   create(type, data, o)           records.create(chain, type, data)
//   update(urn, patch, version, by) records.update(chain, type, id, patch, base_version); a stale base_version fails with StoreError "version_conflict"
//   putSealed(urn, field, v, by)    seal.put({ chain, record, field, class, value }) then records.update(chain, type, id, { [field]: ref }, version): the plaintext never rides a record
//   reveal(urn, field, why, proof)  read the SealedRefValue, seal.reveal({ chain, ref, purpose, proof }) -> { value, expires_in_ms }; HUMAN-ONLY, the chain is one person
//   seesAs(urn, "assistant")        records.get through an assistant's chain: sealed fields come back as SealedPlaceholder (no ref)
//   tasks(q) / task(id)             records.query(chain, "task", ...): the task is a record of the core type "task" in the kernel store
//   request(task)                   ask.request(chain, task)
//   decide(id, { outcome, reason, proof })   ask.decide(chain, id, approval): HUMAN-ONLY, the proof signs this payload; approving a `sent` task is the Gate approval
//   submit(id, evidence, by)        UI-side. The doer's output reaches the record and its files through the gateway; the kernel runs the output check and moves the task
//                                   (working -> needs_check or done: TASK_TRANSITIONS "kernel_after_output_check"). The kernel has no one call for it yet.
//   move(id, to, by, o)             UI-side. The transitions a person or an assistant makes (start, stuck, skip, fix). TASK_TRANSITIONS says who may.
//   events(q)                       events.read(chain, { subject_prefix, corr, since, limit })
//   define(diff) / addField / sealField     records.define(chain, DefineDiff): add or change a type's fields; "seal this field for all records" is a change of its `seal` config
//
// Everything marked UI-side below has no home in the kernel's studs; the gateway adapter derives it (a directory of people and assistants, space colours, the
// calendar) or the kernel gains it (additive changes only).

/** @typedef {import("../../kernel/contracts/common.js").SpaceId} SpaceId */
/** @typedef {import("../../kernel/contracts/common.js").Uuid} Uuid */
/** @typedef {import("../../kernel/contracts/common.js").Urn} Urn */
/** @typedef {import("../../kernel/contracts/common.js").Ms} Ms */
/** @typedef {import("../../kernel/contracts/chain.js").Actor} Actor */
/** @typedef {import("../../kernel/contracts/chain.js").PresenceProof} PresenceProof */
/** @typedef {import("../../kernel/contracts/fields.js").FieldKind} FieldKind */
/** @typedef {import("../../kernel/contracts/fields.js").FieldDefinition} FieldDefinition */
/** @typedef {import("../../kernel/contracts/fields.js").FieldValue} FieldValue */
/** @typedef {import("../../kernel/contracts/fields.js").FieldRendererProps} FieldRendererProps */
/** @typedef {import("../../kernel/contracts/fields.js").RenderMode} RenderMode */
/** @typedef {import("../../kernel/contracts/fields.js").TypeDefinition} TypeDefinition */
/** @typedef {import("../../kernel/contracts/fields.js").StageDef} StageDef */
/** @typedef {import("../../kernel/contracts/fields.js").TaskTemplateDef} TaskTemplateDef */
/** @typedef {import("../../kernel/contracts/fields.js").SealedRefValue} SealedRefValue */
/** @typedef {import("../../kernel/contracts/fields.js").SealedPlaceholder} SealedPlaceholder */
/** @typedef {import("../../kernel/contracts/fields.js").Money} Money */
/** @typedef {import("../../kernel/contracts/fields.js").Address} Address */
/** @typedef {import("../../kernel/contracts/store.js").StoredRecord} StoredRecord */
/** @typedef {import("../../kernel/contracts/store.js").Filter} Filter */
/** @typedef {import("../../kernel/contracts/store.js").Sort} Sort */
/** @typedef {import("../../kernel/contracts/store.js").QuerySpec} QuerySpec */
/** @typedef {import("../../kernel/contracts/store.js").Page<GatewayRecord>} Page */
/** @typedef {import("../../kernel/contracts/store.js").DefineDiff} DefineDiff */
/** @typedef {import("../../kernel/contracts/store.js").DefineResult} DefineResult */
/** @typedef {import("../../kernel/contracts/store.js").StoreError} StoreError */
/** @typedef {import("../../kernel/contracts/gateway.js").GatewayRecord} GatewayRecord */
/** @typedef {import("../../kernel/contracts/task.js").Task} Task */
/** @typedef {import("../../kernel/contracts/task.js").TaskState} TaskState */
/** @typedef {import("../../kernel/contracts/task.js").TaskOutputKind} TaskOutputKind */
/** @typedef {import("../../kernel/contracts/task.js").TaskHow} TaskHow */
/** @typedef {import("../../kernel/contracts/task.js").StuckInfo} StuckInfo */
/** @typedef {import("../../kernel/contracts/task.js").TransitionRule} TransitionRule */
/** @typedef {import("../../kernel/contracts/event.js").EventEnvelope} EventEnvelope */
/** @typedef {import("../../kernel/contracts/seal.js").SealRevealResult} SealRevealResult */
/** @typedef {import("./view-defs.js").ViewDefinition} ViewDefinition */

/**
 * UI-side: who a person, assistant, teammate or service is to a person looking at the Deck. The kernel's Actor is { kind, id, space } and carries a name only for a
 * person; it has no display name for an agent, no avatar seed, no owner ("whose assistant is this", which decides whose Now a stuck task lands in) and no
 * "doing now" line. The adapter builds this from the Space's members, its agents and its team module.
 * `id` is the kernel actor id (per_... for a person, the agent's name, the module's name); `family` picks the avatar and the rules (a person's task is ready, an
 * assistant's starts working).
 * @typedef {{ id: string, name: string, family: "person"|"assistant"|"teammate"|"service", role?: string, doing?: string|null, seed?: string, owner?: string }} Who
 */

/** UI-side: a Space as the Deck draws it. `id` is the SpaceId; the accent and density are the Space's own settings (theme.js). @typedef {{ id: SpaceId, name: string, kind: "mine"|"team", accent?: string, tint?: string, density?: string, font?: string, corners?: string }} Space */

/**
 * UI-side: what a task carries that the kernel's Task does not (Kits may add fields to the task type, SPEC-core-contract.md 9.4, and these are the Deck's). Held under `ext`
 * on the task. The doer's evidence (`result`) is what the real gateway keeps on the record and its files; the Deck reads it from there.
 *   now       what the doer is doing right now ("is reading harlowlegal.com"), from the session's events
 *   say       the one line Now shows, when the task wants to word it
 *   note      the tag on its card ("Needs your approval", "Flow: Large refunds")
 *   required  false when the stage can move on without it (TaskTemplateDef.required)
 *   result    the evidence of an output that is not a field on the record: the draft, the note with its sources, the file
 * @typedef {{ now?: string, say?: string, note?: string, required?: boolean, result?: { draft?: { subject?: string, body: string, sources?: number }, note?: { text: string, sources: string[] }, file?: { name: string } } }} TaskExt
 */

/** A task as the Deck holds it: the kernel's Task, plus the Deck's own extras under `ext`. @typedef {Task & { ext?: TaskExt }} DeckTask */

/**
 * What the doer hands in as the output of a task. The kernel checks it deterministically (fields have values, a note has a source, a decision has a reason).
 * @typedef {{ draft?: { subject?: string, body: string, sources?: number }, note?: { text: string, sources: string[] }, file?: { name: string }, decision?: { answer: "yes"|"no", reason: string } }} Evidence
 */

/**
 * The Store the generated screens read. Every method may be async; a screen awaits it and shows the state kit's skeleton, empty and error states. `subscribe` calls
 * back after any change so a screen redraws from the store, never from its own copy. A refused call throws an Error whose `code` is a StoreError code
 * ("version_conflict", "not_found", "sealed_value_refused", "invalid") and whose `message` is plain words.
 * @typedef {{
 *   spaces(): Promise<Space[]>,
 *   actors(): Promise<Who[]>,
 *   types(space?: SpaceId): Promise<TypeDefinition[]>,
 *   list(type: string, q?: { space?: SpaceId, filter?: Filter, sort?: Sort[] }): Promise<GatewayRecord[]>,
 *   get(urn: Urn): Promise<GatewayRecord|null>,
 *   create(type: string, data: Record<string, FieldValue>, opts?: { by?: string, why?: string, space?: SpaceId }): Promise<GatewayRecord>,
 *   update(urn: Urn, patch: Record<string, FieldValue>, base_version: number, by?: string): Promise<GatewayRecord>,
 *   putSealed(urn: Urn, field: string, value: string, by?: string): Promise<GatewayRecord>,
 *   reveal(urn: Urn, field: string, purpose: string, proof: PresenceProof): Promise<SealRevealResult>,
 *   seesAs(urn: Urn, who: "person"|"assistant"): Promise<Record<string, FieldValue>>,
 *   tasks(q?: { record?: Urn, doer?: string, checker?: string, state?: TaskState[], space?: SpaceId }): Promise<DeckTask[]>,
 *   task(id: Uuid): Promise<DeckTask|null>,
 *   request(task: NewTask, by?: string): Promise<DeckTask>,
 *   decide(id: Uuid, approval: { outcome: "approved"|"rejected", reason?: string, proof: PresenceProof }): Promise<DeckTask>,
 *   submit(id: Uuid, evidence: Evidence, by?: string): Promise<DeckTask>,
 *   move(id: Uuid, to: TaskState, by?: string, o?: { reason?: string, suggested_fix?: string }): Promise<DeckTask>,
 *   reassign(id: Uuid, doer: string, by?: string): Promise<DeckTask>,
 *   editTask(id: Uuid, patch: { how?: TaskHow, due?: number, title?: string }, by?: string): Promise<DeckTask>,
 *   events(q?: { record?: Urn, task?: Uuid, limit?: number }): Promise<EventEnvelope[]>,
 *   define(diff: DefineDiff): Promise<DefineResult>,
 *   addField?(type: string, spec: { label: string, kind: FieldKind, to?: string, options?: string[] }): Promise<FieldDefinition>,
 *   sealField?(type: string, field: string): Promise<FieldDefinition|undefined>,
 *   subscribe(fn: () => void): () => void,
 *   me?(): Promise<string>,
 *   calendar?(q?: { day?: number }): Promise<{ id: string, at: number, title: string, sub?: string, record?: Urn }[]>,
 * }} Store
 * Optional (UI-side, until the kernel has them): `me` (the actor id of the person using this Deck; the chain's first hop), `calendar` (today's events; Now shows an
 * empty calendar when it is missing), `addField` and `sealField` (both are records.define calls).
 */

/**
 * What a task request carries: the kernel's Task without what the kernel writes (id, state, space, assigned_by, labels, times). `doer` and `checker` are actor ids here
 * (the gateway builds the Actor with the Space and checks the checker is a person); `record` is a urn.
 * @typedef {Omit<Task, "id"|"state"|"space"|"assigned_by"|"labels"|"created_at"|"updated_at"|"doer"|"checker"|"helpers"> & { doer: string, checker?: string, helpers?: string[], state?: TaskState, ext?: TaskExt }} NewTask
 */

export {};
