// kernel/contracts/common.d.ts: shared names. Types only, no logic.
// Source of truth: team/0.3/SPEC-core-contract.md (the contract) and KERNEL-brief.md (the ten invariants).

/** `spc_` plus 12 base32 characters of the hash of the Space's box key (contract 2). */
export type SpaceId = string;

/** A time-prefixed UUID (v7 layout, v4 marker), lowercase canonical text (contract 2, Ids). */
export type Uuid = string;

/** `vyre://<space>/<type>/<id>[/<path>]` (contract 3.3). A reference is not access. */
export type Urn = string;

/** Milliseconds since the Unix epoch. */
export type Ms = number;

/** Base64url, no padding. */
export type B64 = string;

/**
 * Where content came from, set by the kernel at Ingress, never by a module (invariant 9, contract 7.6).
 * `system`: kernel and first-party reviewed code. `member`: a person or agent of the Space.
 * `external`: outside the Space (mail, web, a projection, Kit text until reviewed). `untrusted`: known hostile or unauthenticated.
 */
export type TrustLabel = 'system' | 'member' | 'external' | 'untrusted';

/** How a payload may be used later (contract 7.5). `secret` is never stored: the write is refused. */
export type RedactionClass = 'public' | 'internal' | 'pii' | 'privileged' | 'secret';

/** Who may read an event (contract 7.4). */
export type Visibility = 'space' | `members:${string}` | 'actor' | 'subject' | 'owner';

/** Risk class of an action (contract 6.1). Anything unknown is treated as `outward.share` (invariant 1). */
export type Risk =
  | 'read' | 'write' | 'admin' | 'grant'
  | 'outward.send' | 'outward.pay' | 'outward.publish' | 'outward.delete' | 'outward.share';

/** `<module>.<verb>`, exactly two segments (contract 6.1). */
export type ActionName = string;

/** The label a derived item carries: the weakest trust of its inputs, the strongest class, and every source Space (invariants 7 and 9). */
export interface Labels {
  trust: TrustLabel;
  red: RedactionClass;
  /** The set of Spaces the content came from. More than one makes a multi-Space context (draft-only writes). */
  source_spaces: readonly SpaceId[];
}

/** A typed error every kernel call can throw or return. `code` is stable and lowercase. */
export interface KernelError {
  code: string;
  message: string;
  /** Present when the true reason must not leak to the caller (refusals look like absence, invariant 8). */
  hidden_reason?: string;
}
