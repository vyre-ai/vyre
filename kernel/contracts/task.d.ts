// kernel/contracts/task.d.ts: the task record and its state machine. Types only, no logic.
// Contract 9.4; invariant 4. The transition table itself is data in index.js (TASK_TRANSITIONS).

import type { SpaceId, Uuid, Ms, Urn, Labels } from './common.js';
import type { Actor } from './chain.js';

export type TaskState = 'waiting' | 'ready' | 'working' | 'needs_check' | 'stuck' | 'done' | 'skipped';

export type TaskOutputKind = 'fields' | 'note' | 'draft' | 'sent' | 'decision' | 'file';

export interface TaskOutput {
  readonly kind: TaskOutputKind;
  /** Fields to fill, a note's target record, a draft's template, and so on. */
  readonly target?: string | readonly string[];
}

export type TaskHow = 'template' | 'tailor' | 'assistant' | 'person';

/** Tasks the kernel makes carry a source; stage and manual tasks may omit it. */
export type TaskSource =
  | 'gate_hold' | 'grant_request' | 'pairing' | 'kit_install' | 'reveal_request' | 'continue_in_space'
  | 'flow_step' | 'assistant_request' | 'memory_proposal' | 'manual';

export interface StuckInfo {
  readonly reason: string;
  readonly since: Ms;
  /** Quoted text in the doer's block. A model's own fix gives no one-tap grant; a permission fix is built by the kernel from observed denials. */
  readonly suggested_fix?: { readonly text: string; readonly action?: { readonly kind: 'grant_request' | 'reassign' | 'open_vault_item' | 'raise_budget'; readonly resource?: Urn; readonly action_name?: string } };
}

/**
 * The task record. The fields that carry approval truth (state after `needs_check`, outcome, payload, binding,
 * checker, doer) are written ONLY by the kernel (contract 9.4, R6-6). A Kit may add fields, never touch these.
 */
export interface Task {
  readonly id: Uuid;
  readonly space: SpaceId;
  readonly title: string;
  readonly record?: Urn;
  readonly stage?: string;
  readonly source?: TaskSource;
  readonly doer: Actor;
  readonly helpers?: readonly Actor[];
  /** Resolved to person actors only; a role is expanded to the humans who hold it. A `sent` or other outward output always has one. */
  readonly checker?: Actor | { readonly role: string };
  readonly output: TaskOutput;
  readonly how?: TaskHow;
  readonly template?: Urn;
  readonly inputs?: readonly Urn[];
  readonly depends_on?: readonly Uuid[];
  readonly due?: Ms;
  readonly escalate_after?: Ms;
  readonly escalate_to?: Actor;
  /** The stage's required flag: with a checker or an outward output it makes `ready` to `skipped` a proposal, not the doer's act. */
  readonly required?: boolean;
  /** Free text from the doer: shown to the checker only in the separate "from <doer>" block, capped, never as a button or link. */
  readonly note?: string;
  readonly state: TaskState;
  readonly stuck?: StuckInfo;
  readonly session?: string;
  readonly outcome?: 'approved' | 'rejected' | 'answered' | 'cancelled' | 'expired';
  readonly answer?: unknown;
  readonly form?: unknown;
  /** A Flow reference sent with a held-act or paused task: opaque, kernel-quoted. */
  readonly flow?: string;
  /** For a held outward act: the canonical outbound payload hash, the decision it is bound to, the final draft hash. */
  readonly payload?: { readonly payload_hash: string; readonly decision: string; readonly draft_hash?: string };
  /** Who assigned it: part of the chain a teammate works under, so an assigner cannot borrow a broader teammate. */
  readonly assigned_by: Actor;
  readonly labels: Labels;
  readonly created_at: Ms;
  readonly updated_at: Ms;
}

/** Who is allowed to perform a transition (contract 9.4, "Who may move a task"). */
export type TransitionBy =
  | 'kernel_after_output_check'
  | 'checker_approval'
  | 'checker'
  | 'doer'
  | 'doer_or_person'
  | 'proposal_for_person_with_presence'
  | 'responsible_person_or_person_with_presence'
  | 'assistant_or_detection'
  | 'dependencies_met'
  | 'nobody';

export interface TransitionRule {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly by: TransitionBy;
  /** True when the rule applies only to a task with a checker, an outward output or the stage's required flag. */
  readonly guarded?: boolean;
}

export interface TaskApi {
  /** `ask.request`: a task assigned to an actor, with an optional checker. */
  request(chain: import('./chain.js').Chain, task: Omit<Task, 'id' | 'state' | 'created_at' | 'updated_at' | 'labels' | 'assigned_by' | 'space'> & { readonly state?: TaskState }): Promise<Task>;
  /** `ask.decide` is HUMAN-ONLY: the chain must be exactly one person and the proof must sign this payload. */
  decide(chain: import('./chain.js').Chain, task: Uuid, approval: { readonly outcome: 'approved' | 'rejected'; readonly reason?: string; readonly proof?: import('./chain.js').PresenceProof }): Promise<Task>;
  get(chain: import('./chain.js').Chain, task: Uuid): Promise<Task | null>;
  /** The doer starts work (`ready` to `working`). */
  start(chain: import('./chain.js').Chain, task: Uuid): Promise<Task>;
  /** The doer says the output exists. The kernel checks it against the declared output kind before anything moves. */
  complete(chain: import('./chain.js').Chain, task: Uuid, evidence: unknown): Promise<Task>;
  /** The doer changes a draft that is waiting for its checker: the approval is void and the task is `ready` again. */
  revise(chain: import('./chain.js').Chain, task: Uuid, reason: string): Promise<Task>;
  /** The doer cannot go on. Its suggested fix is quoted text; a one-tap fix comes only from the kernel's own observations. */
  stuck(chain: import('./chain.js').Chain, task: Uuid, info: { readonly reason: string; readonly suggested_fix?: string }): Promise<Task>;
  /** A person unblocks or reassigns a stuck task. Never the doer. */
  unblock(chain: import('./chain.js').Chain, task: Uuid, opts: { readonly reassign_to?: Actor; readonly proof?: import('./chain.js').PresenceProof }): Promise<Task>;
  /** Skip: the doer's own act for an unguarded task; for a guarded one it raises a proposal for a person. */
  skip(chain: import('./chain.js').Chain, task: Uuid, reason: string): Promise<Task | { readonly proposal: Task }>;
  /** The Now view: everything waiting on this person. */
  needsYou(chain: import('./chain.js').Chain): Promise<readonly Task[]>;
  /** Did a checker approve exactly this payload? (`seal.use` asks.) */
  approved(task: Uuid, payload_hash: string): boolean;
}
