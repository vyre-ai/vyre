// kernel/contracts/seal.d.ts: the sealing process's surface. Types only, no logic.
// Contract 8; invariants 4, 5 and 6. `seal.put` and `seal.use` are model-free; `seal.reveal` is HUMAN-ONLY.

import type { Chain, PresenceProof } from './chain.js';
import type { Urn } from './common.js';
import type { SealedRefValue } from './fields.js';

/** Declarative classes only: a fixed set of checksums and patterns the kernel ships (R5-8). A Kit cannot add one. */
export type SealClass =
  | 'us-ssn' | 'us-itin' | 'us-ein' | 'card' | 'bank-account' | 'routing-number' | 'iban' | 'passport' | 'tax-id' | 'medical' | 'free';

export interface SealPutInput {
  readonly chain: Chain;
  readonly record: Urn;
  readonly field: string;
  readonly class: SealClass;
  /** The one place plaintext crosses into the sealing process. It is never returned, logged or stored outside it. */
  readonly value: string;
  readonly hint_allowed?: boolean;
}

export interface SealPutResult { readonly ref: SealedRefValue }

/** A destination a sealed merge may go to: the record's own verified contact point, or a document for that record (R5-4). */
export type SealDestination =
  | { readonly kind: 'contact_point'; readonly record: Urn; readonly contact: string; readonly verified: true }
  | { readonly kind: 'document'; readonly record: Urn; readonly document: Urn };

/** The slot is declared by the template; a model can never introduce one, and positions are body-only (R6-4). */
export interface SealUseInput {
  readonly chain: Chain;
  readonly ref: string;
  readonly template: Urn;
  readonly template_version: number;
  readonly slot: string;
  readonly destination: SealDestination;
  /** The task whose checker approved this exact payload. */
  readonly task?: string;
}

/** The merged output is handed to the egress boundary, never to the caller. The caller learns only that it happened. */
export interface SealUseResult { readonly merged: true; readonly output_ref: Urn }

export interface SealRevealInput {
  readonly chain: Chain;
  readonly ref: string;
  readonly purpose: string;
  /** Required: a biometric-gated hardware-key proof over this reveal. The chain must be exactly one person. */
  readonly proof: PresenceProof;
}

/** Returned to the person's blind, content-protected reveal view only. */
export interface SealRevealResult { readonly value: string; readonly expires_in_ms: number }

export interface SealApi {
  put(input: SealPutInput): Promise<SealPutResult>;
  use(input: SealUseInput): Promise<SealUseResult>;
  reveal(input: SealRevealInput): Promise<SealRevealResult>;
  /** Move a sealed value into another Space's namespace inside the process: the same one person in both chains, no model in either; the kernel authorised the move first. A new ref in the target. */
  reseal(input: { chain: Chain; to_chain: Chain; ref: string; to_record: string; field: string }): Promise<SealPutResult>;
}
