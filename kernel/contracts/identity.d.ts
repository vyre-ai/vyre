// kernel/contracts/identity.d.ts: Identity is the base type; devices, nodes, offers and uses sit on it. Types only, no logic.
// Source: team/0.3/DESIGN-wink.md sections 1, 3 and 7. The six primitives stay the same, with Identity under Actor and Record.

import type { Uuid, Ms, B64 } from './common.js';

/** The fixed starting set of kinds. It can grow, so a reader treats an unknown kind as the most restrictive (invariant 1). */
export type IdentityKind = 'user' | 'space' | 'device' | 'agent' | 'project' | 'session' | 'task';

/** A stable id plus a kind tag. Grants, events, ownership and record ids all refer to identities. The id never changes. */
export interface Identity {
  readonly id: Uuid | string;
  readonly kind: IdentityKind;
}

/** Only users and spaces get a name (`alex.vyre.run`, `harlow.vyre.run`). A name points at the identity, never at one key. */
export type NamedIdentityKind = 'user' | 'space';
/** Users, spaces, devices and agents have keys. Projects, sessions and tasks are identities without keys, owned by a space. */
export type KeyedIdentityKind = 'user' | 'space' | 'device' | 'agent';

export interface NamedIdentity extends Identity {
  readonly kind: NamedIdentityKind;
  readonly name: import('./roles.js').VyreName;
}

/** Who may speak for a user or a space: a signed list. Each change is signed by an entry already on the list. */
export interface SpeakerEntry {
  readonly kind: 'device' | 'recovery_code' | 'recovery_contact' | 'owner';
  readonly id: string;
  readonly public_key: B64;
  readonly added_at: Ms;
  /** The entry that signed this one in. A newcomer cannot remove older entries or change recovery for its first 24 hours. */
  readonly added_by: string;
}

export type DeviceKind = 'phone' | 'computer' | 'server' | 'storage_device';

/** What a device can offer. A phone offers access and approval only; a storage device offers storage only. */
export type OfferKind = 'access' | 'approval' | 'compute' | 'storage';

/**
 * A device belongs to a user identity, or to a space identity for its servers and storage. It is never a member of a
 * space: access always flows through the user identity's grant (invariant 2 stays: the chain names the person).
 */
export interface Device {
  readonly identity: Identity & { readonly kind: 'device' };
  readonly owner: Identity & { readonly kind: 'user' | 'space' };
  readonly device_kind: DeviceKind;
  /** What the owner allows this device to offer, set by the owner. */
  readonly allows: readonly OfferKind[];
}

/** The offers each device kind may carry; anything else is refused at registration. */
export type DeviceOffers = {
  readonly phone: readonly ['access', 'approval'];
  readonly computer: readonly ['access', 'approval', 'compute'];
  readonly server: readonly ['compute', 'storage'];
  readonly storage_device: readonly ['storage'];
};

/** A device as the network sees it: reachable, with what it offers right now. */
export interface Node {
  readonly device: Identity & { readonly kind: 'device' };
  readonly device_kind: DeviceKind;
  readonly online: boolean;
  /** Computers offer compute only while awake and plugged in, if the owner allows it. */
  readonly available: readonly OfferKind[];
}

/** One side of an agreement: a space allowing its work to run on members' computers, or a member accepting it. */
export interface Offer {
  readonly id: Uuid;
  readonly side: 'space_allows' | 'member_accepts';
  readonly space: Identity & { readonly kind: 'space' };
  /** For `member_accepts`: the member's own computer. For `space_allows`: absent, the space grants it to its members generally or per member. */
  readonly device?: Identity & { readonly kind: 'device' };
  readonly member?: Identity & { readonly kind: 'user' };
  readonly offer: 'compute';
  readonly status: 'active' | 'revoked';
  readonly made_by: Identity;
  readonly at: Ms;
}

/**
 * Running a space's work on a member's computer. It needs both grants (the space allows it and the member accepts) and it
 * covers only that member's own sessions on that member's own machine: another member or an admin cannot start work there.
 */
export interface Use {
  readonly space: Identity & { readonly kind: 'space' };
  readonly member: Identity & { readonly kind: 'user' };
  readonly device: Identity & { readonly kind: 'device' };
  readonly session: Identity & { readonly kind: 'session' };
  readonly allowed_by: string;
  readonly accepted_by: string;
}
