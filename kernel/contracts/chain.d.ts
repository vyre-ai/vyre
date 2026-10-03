// kernel/contracts/chain.d.ts: the acting chain and presence evidence. Types only, no logic.
// Contract 4.1 and 4.2; invariants 2, 3 and 4.

import type { SpaceId, Ms, B64, Labels } from './common.js';

/** Contract 4.1. A model is only ever an `agent`. */
export type ActorKind = 'person' | 'agent' | 'device' | 'service' | 'automation';

/** `<kind>:<id>@<space>`. A person is one global key with a membership in each Space they belong to. */
export interface Actor {
  readonly kind: ActorKind;
  /** per_... (26 base32), agent name, device key id, module name, or fl_... for an automation. */
  readonly id: string;
  /** The Space whose authority is evaluating, and so where this actor holds a membership. */
  readonly space: SpaceId;
  /** A person's Vyre name (`alex.vyre.run`), the signed claim of their person key. Set only on `person`; display and lookup, never authority: roles and grants refer to `id`. */
  readonly name?: import('./roles.js').VyreName;
}

/** The surface a verified request arrived on. Derived by the Surfaces door, never read from a header string. */
export type Surface = 'deck' | 'capsule' | 'cli' | 'mobile' | 'local' | 'mcp' | 'harness' | 'hook' | 'onboard' | 'link' | 'relay';

export interface Via {
  readonly surface?: Surface;
  /** `device:<key id>` of the enrolled device. */
  readonly device?: string;
  readonly node?: string;
  readonly session?: string;
}

/** How the kernel came to add this hop. A caller can never add a hop itself (invariant 2). */
export type HopEntry = 'surface' | 'session' | 'registry' | 'assignment' | 'job' | 'stage_rule';

export interface Hop {
  readonly actor: Actor;
  readonly via?: Via;
  readonly entered_by: HopEntry;
}

declare const CHAIN: unique symbol;

/**
 * An immutable chain of hops, for example [person:alex, agent:intake, service:email]. Effective authority
 * is the intersection of every hop's grants. Only the kernel builds one: the brand makes a hand-made object
 * unassignable to this type. No tool accepts a Chain, `via`, `labels`, `presence` or `input_hash` from its input.
 * A queued, scheduled or event-triggered job stores its chain with the job.
 */
export interface Chain {
  readonly [CHAIN]: true;
  readonly space: SpaceId;
  readonly hops: readonly Hop[];
  /** Minimum trust over everything the chain consumed; every Space the context drew from. */
  readonly labels: Labels;
  readonly built_at: Ms;
  /** Set when the chain was restored from a stored job. */
  readonly job?: string;
}

/** What the Surfaces door verified about a connection. The chain builder takes only this. */
export type SurfaceFacts =
  | { readonly kind: 'socket'; readonly surface: Surface; readonly uid: number; readonly pid: number | null; readonly inside_model_process: boolean; readonly capsule_verified: boolean }
  | { readonly kind: 'device'; readonly device_key_id: string; readonly person: string; readonly session?: string; readonly path: 'direct' | 'relay' | 'wink' }
  | { readonly kind: 'agent_session'; readonly agent: string; readonly session: string; readonly thread: string; readonly vouched: boolean }
  | { readonly kind: 'module'; readonly module: string; readonly first_party: boolean; readonly inbound?: Chain }
  | { readonly kind: 'job'; readonly stored: Chain };

/** The operating system's user-verification signers (invariant 4). A click is not one of them. */
export type PresenceSigner = 'secure_enclave' | 'tpm' | 'windows_hello' | 'strongbox' | 'webauthn_platform';

/**
 * A presence proof: a signature, made by a biometric-gated hardware key, over THIS payload.
 * The kernel verifies it and checks the chain is exactly one person; it cannot tell a human from software,
 * which is why the signer is a hardware gesture and the signer client is in the trusted base.
 */
export interface PresenceProof {
  readonly signer: PresenceSigner;
  readonly key_id: string;
  /** sha-256 of the canonical outbound payload (recipients, subject, headers, attachments, sealed slots, template version, account). */
  readonly payload_hash: B64;
  /** The decision this proof is bound to. */
  readonly decision: string;
  readonly chain_hash: B64;
  readonly issued_at: Ms;
  readonly expires_at: Ms;
  readonly nonce: B64;
  readonly signature: B64;
}
