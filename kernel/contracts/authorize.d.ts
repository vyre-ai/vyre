// kernel/contracts/authorize.d.ts: the one decision point. Types only, no logic.
// Contract 6.3; invariants 1, 2, 3 and 4.

import type { Chain, PresenceProof } from './chain.js';
import type { ActionName, Risk, Urn } from './common.js';

export interface AuthorizeInput {
  /** Built by the kernel. A module-facing `ctx.authorize(action, resource)` passes only the next two fields. */
  readonly chain: Chain;
  readonly action: ActionName;
  readonly resource: Urn;
  /** A coarse class of the input (for example the recipient domain), never the input itself. */
  readonly input_class?: string;
  /** Evidence the kernel attaches when the call carries a presence proof. Never supplied by a module. */
  readonly presence?: PresenceProof;
}

export type Effect = 'allow' | 'deny' | 'ask';

/** Stable reason codes. A refusal may show only `not_found` to the caller and keep the true code in the log. */
export type ReasonCode =
  | 'ok' | 'no_grant' | 'expired' | 'wrong_space' | 'wrong_node' | 'needs_presence' | 'needs_approval'
  | 'sealed' | 'tainted' | 'limit' | 'undeclared' | 'not_a_member' | 'chain_not_person' | 'revoked'
  | 'pattern_not_covered' | 'not_contained' | 'unknown_action' | 'bad_input' | 'not_found';

/** What the kernel must still enforce before the action runs (contract 6.3). A module cannot skip these. */
export type Obligation =
  | { readonly type: 'presence'; readonly method: 'session' | 'fresh' }
  | { readonly type: 'ask'; readonly kind: Risk; readonly approver: 'owner' | `role:${string}` | string; readonly checker_must_be_person: true }
  | { readonly type: 'meter'; readonly meter: string; readonly amount: number }
  | { readonly type: 'audit'; readonly class: 'deny' | 'ask' | 'outward' | 'sample' }
  | { readonly type: 'placeholders'; readonly fields: readonly string[] };

export interface AuthorizeOutput {
  readonly effect: Effect;
  readonly reason: ReasonCode;
  /** Grants that carried the decision. */
  readonly grants: readonly string[];
  readonly obligations: readonly Obligation[];
  /** `dec_<uuid>`: carried by the event the action produces, and bound into any approval. */
  readonly decision: string;
  readonly policy_version: number;
}

/** The registry entry for an action (contract 6.1). */
export interface ActionDef {
  readonly action: ActionName;
  readonly resource_type: string;
  readonly risk: Risk;
  /** Plain words for cards. */
  readonly label: string;
  readonly gloss: string;
  /** True only for actions the sealing process may run model-free (invariant 6). */
  readonly sealed_ok?: boolean;
}

/** The whole `authorize` surface: one function. */
export interface Authorizer {
  authorize(input: AuthorizeInput): Promise<AuthorizeOutput>;
}
