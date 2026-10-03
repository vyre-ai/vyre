// kernel/contracts/grant.d.ts: grants, selectors and conditions. Types only, no logic.
// Contract 6.2; invariants 2 and 10.

import type { SpaceId, Ms, Urn, ActionName } from './common.js';
import type { Actor, Surface } from './chain.js';

/** A URN prefix with `*` in one segment, plus predicates over KERNEL attributes only (never a module resolver's). */
export interface Selector {
  readonly prefix: Urn;
  readonly where?: readonly SelectorPredicate[];
}

export interface SelectorPredicate {
  /** Kernel attributes only: space, owner, sensitivity, project, created_by, version. */
  readonly attr: 'space' | 'owner' | 'sensitivity' | 'project' | 'created_by';
  readonly op: 'eq' | 'ne' | 'in';
  readonly value: string | readonly string[];
}

export type Subject =
  | { readonly kind: 'actor'; readonly actor: Actor }
  | { readonly kind: 'role'; readonly name: string }
  | { readonly kind: 'group'; readonly id: string };

export interface GrantConditions {
  readonly where?: { readonly nodes?: readonly string[]; readonly residency?: readonly string[]; readonly surfaces?: readonly Surface[] };
  readonly when?: { readonly not_before?: Ms; readonly expires: Ms; readonly schedule?: string };
  readonly how?: { readonly presence?: 'none' | 'session' | 'fresh'; readonly approval?: { readonly by: 'owner' | `role:${string}` | string; readonly once?: boolean } };
  readonly budget?: { readonly meter: string; readonly limit: number };
  readonly delegate?: { readonly allowed: boolean; readonly max_depth: 0 | 1 | 2 | 3 };
  /** Service ids that may use the grant on the subject's behalf. */
  readonly audience?: readonly string[];
  readonly rate?: { readonly n: number; readonly per_seconds: number };
}

/** Stored in the Space that owns the resource. Never edited to widen: widening is a new grant. */
export interface Grant {
  /** `gr_` plus a time-prefixed UUID. */
  readonly id: string;
  readonly space: SpaceId;
  readonly subject: Subject;
  readonly actions: readonly ActionName[];
  /** The action-set version the grant was made against: a pattern covers only the actions that existed then. */
  readonly action_set_version: number;
  readonly resource: Selector;
  readonly conditions: GrantConditions;
  readonly issuer: Actor;
  /** For example "wink:W5", "role:member", "flow:fl_...", "install:crm". */
  readonly source: string;
  /** Set on a delegated grant. The delegate's grant must be structurally contained in its parent's. */
  readonly parent?: string;
  readonly status: 'active' | 'revoked';
  readonly created_at: Ms;
  readonly revoked_at?: Ms;
  readonly reason?: string;
}

export interface GrantInput {
  readonly subject: Subject;
  readonly actions: readonly ActionName[];
  readonly resource: Selector;
  readonly conditions: GrantConditions;
  readonly source: string;
  readonly parent?: string;
  readonly reason?: string;
}

/** The grants calls. `create` for a delegate converts the parent's presence and approval conditions into obligations. */
export interface GrantsApi {
  create(chain: import('./chain.js').Chain, input: GrantInput): Promise<Grant>;
  revoke(chain: import('./chain.js').Chain, id: string, reason: string): Promise<Grant>;
  list(chain: import('./chain.js').Chain, filter?: { readonly subject?: Subject; readonly resource_prefix?: Urn; readonly status?: 'active' | 'revoked' }): Promise<readonly Grant[]>;
}
