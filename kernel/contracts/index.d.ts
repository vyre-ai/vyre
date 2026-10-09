// kernel/contracts/index.d.ts: the studs. Re-exports every contract type. Types only, no logic.
export * from './common.js';
export * from './chain.js';
export * from './authorize.js';
export * from './grant.js';
export * from './roles.js';
export * from './identity.js';
export * from './event.js';
export * from './store.js';
export * from './task.js';
export * from './fields.js';
export * from './model.js';
export * from './seal.js';
export * from './gateway.js';

import type { ActorKind, Surface, PresenceSigner } from './chain.js';
import type { TrustLabel, RedactionClass, Risk, Visibility } from './common.js';
import type { Effect, ReasonCode } from './authorize.js';
import type { TaskState, TaskOutputKind, TaskHow, TaskSource, TransitionRule } from './task.js';
import type { FieldKind } from './fields.js';
import type { SealClass } from './seal.js';
import type { StoreErrorCode } from './store.js';
import type { RoleId, RoleBundle } from './roles.js';
import type { IdentityKind, NamedIdentityKind, KeyedIdentityKind, DeviceKind, OfferKind } from './identity.js';

export const IDENTITY_KINDS: readonly IdentityKind[];
export const NAMED_IDENTITY_KINDS: readonly NamedIdentityKind[];
export const KEYED_IDENTITY_KINDS: readonly KeyedIdentityKind[];
export const DEVICE_KINDS: readonly DeviceKind[];
export const OFFER_KINDS: readonly OfferKind[];
/** Which offers each device kind may carry. */
export const DEVICE_OFFERS: Readonly<Record<DeviceKind, readonly OfferKind[]>>;

export const ACTOR_KINDS: readonly ActorKind[];
export const SURFACES: readonly Surface[];
export const PRESENCE_SIGNERS: readonly PresenceSigner[];
/** Weakest first: the label of a derived item is the earliest of its inputs in this order. */
export const TRUST_ORDER: readonly TrustLabel[];
/** Weakest first; the class of a derived item is the LATEST of its inputs (privileged outranks pii). */
export const REDACTION_ORDER: readonly RedactionClass[];
export const RISKS: readonly Risk[];
export const OUTWARD_RISKS: readonly Risk[];
export const EFFECTS: readonly Effect[];
export const REASON_CODES: readonly ReasonCode[];
export const VISIBILITY_KINDS: readonly string[];
export const TASK_STATES: readonly TaskState[];
export const TASK_OUTPUT_KINDS: readonly TaskOutputKind[];
export const TASK_HOW: readonly TaskHow[];
export const TASK_SOURCES: readonly TaskSource[];
export const TASK_TRANSITIONS: readonly TransitionRule[];
export const FIELD_KINDS: readonly FieldKind[];
export const SEAL_CLASSES: readonly SealClass[];
export const STORE_ERROR_CODES: readonly StoreErrorCode[];
export const CONTRACTS_VERSION: string;

/** Strongest first. */
export const ROLE_IDS: readonly RoleId[];
/** Owner 4 down to temp 0. */
export const ROLE_RANK: Readonly<Record<RoleId, number>>;
export const ROLE_LABELS: Readonly<Record<RoleId, string>>;
export const ROLE_DEMOTE_TO: readonly RoleId[];
export const ROLE_MAY_SET: Readonly<Record<RoleId, readonly RoleId[]>>;
export const ROLE_BUNDLES: Readonly<Record<RoleId, RoleBundle>>;
