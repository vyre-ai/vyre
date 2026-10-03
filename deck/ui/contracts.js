// @ts-check
// deck/ui/contracts: the shapes the generated Deck screens read, as JSDoc types only (no code runs). They are the Deck's side of the kernel's
// records, tasks and event log (team/0.3/DESIGN-tasks.md, ui-primitives.md). Until the real gateway lands (platform's kernel/contracts/), the screens read a
// store with exactly this interface (ui/mock-store.js); when it lands, an adapter maps its types onto these and nothing else changes.
// A field's value is plain JSON; a sealed field's value is never in it (the gateway returns { sealed: true, last4?: string } in its place).

/** @typedef {{ id: string, kind: "person"|"assistant"|"teammate"|"device", name: string, role?: string, doing?: string|null, seed?: string }} Actor */

/** @typedef {"text"|"number"|"money"|"date"|"choice"|"stage"|"actor"|"link"|"file"|"address"|"phone"|"email"|"richText"|"rating"|"sealed"} FieldKind */

/**
 * @typedef {{ key: string, label: string, kind: FieldKind, options?: string[], stages?: string[], currency?: string, link?: string,
 *   sealed?: boolean, showLast4?: boolean, required?: boolean }} FieldDef
 * `sealed` on a field of any kind means the field is sealed from every assistant on every record of the type (set once, by a space admin).
 */

/**
 * @typedef {{ list?: { columns: string[], sort?: string }, board?: { groupBy: string, card: string[] }, calendar?: { date: string },
 *   dashboard?: { widgets: { kind: "sum"|"countBy"|"funnel"|"recent", field?: string, where?: string }[] } }} ViewDefs
 */

/**
 * @typedef {{ id: string, name: string, plural: string, icon: string, fields: FieldDef[], views: ViewDefs, holdsWork?: boolean,
 *   titleKey: string, space: string }} TypeDef
 * `holdsWork`: the type appears under Projects and its record page has tasks, members, chats and files; otherwise it is its own rail item.
 */

/** @typedef {{ id: string, type: string, space: string, values: Record<string, any>, stage?: string, createdAt: number, updatedAt: number }} RecordRow */

/** @typedef {"waiting"|"ready"|"working"|"needs_check"|"stuck"|"done"|"skipped"} TaskState */
/** @typedef {"fields"|"note"|"draft"|"sent"|"decision"|"file"} TaskOutputKind */
/** @typedef {"template"|"tailor"|"assistant"|"person"} TaskHow */

/**
 * @typedef {{ id: string, title: string, record: string, stage?: string, doer: string, checker?: string|null, helpers?: string[],
 *   output: { kind: TaskOutputKind, target?: string, fields?: string[] }, how?: TaskHow, template?: string, inputs?: string[], dependsOn?: string[],
 *   due?: number|null, state: TaskState, stuck?: { reason: string, since: number, suggestedFix: string }|null, session?: string|null,
 *   madeBy?: string, note?: string }} Task
 * `doer` and `checker` are actor ids. When a task's output leaves the space (output.kind "sent"), the checker's approval is the Gate approval: one card.
 */

/** @typedef {{ id: string, record?: string, task?: string, actor: string, what: string, at: number, why?: string }} VyreEvent */

/** @typedef {{ id: string, name: string, kind: "mine"|"team", accent?: string, tint?: string, density?: string, font?: string, corners?: string }} Space */

/**
 * The store the generated screens read. Every method may be async; a screen awaits it and shows the state kit's skeleton, empty and error states.
 * `subscribe` calls back after any change so a screen redraws from the store, never from its own copy.
 * @typedef {{
 *   spaces(): Promise<Space[]>,
 *   actors(): Promise<Actor[]>,
 *   types(space?: string): Promise<TypeDef[]>,
 *   list(typeId: string, q?: { space?: string, where?: Record<string, any>, sort?: string }): Promise<RecordRow[]>,
 *   get(id: string): Promise<RecordRow|null>,
 *   create(typeId: string, values: Record<string, any>): Promise<RecordRow>,
 *   update(id: string, patch: Record<string, any>, by?: string): Promise<RecordRow>,
 *   tasks(q?: { record?: string, doer?: string, checker?: string, state?: TaskState[], space?: string }): Promise<Task[]>,
 *   task(id: string): Promise<Task|null>,
 *   updateTask(id: string, patch: Partial<Task>, by?: string): Promise<Task>,
 *   approveTask(id: string, proof: { method: "face_id"|"touch_id"|"passkey" }): Promise<Task>,
 *   reassignTask(id: string, doer: string): Promise<Task>,
 *   events(q: { record?: string, task?: string, limit?: number }): Promise<VyreEvent[]>,
 *   reveal(recordId: string, key: string, proof: { method: string }): Promise<{ value: string, until: number }>,
 *   seesAs(recordId: string, who: "person"|"assistant"): Promise<Record<string, any>>,
 *   subscribe(fn: () => void): () => void,
 * }} Store
 */

export {};
