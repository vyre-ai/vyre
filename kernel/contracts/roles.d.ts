// kernel/contracts/roles.d.ts: the five roles as grant bundles, the Vyre name, and the Space identity. Types only, no logic.
// team/0.3/DESIGN-spaces-first.md section 4 and 1b; contract section on roles. Roles are tied to a person's identity, never to a device.

import type { SpaceId, Ms } from './common.js';

/** `<label>.vyre.run`, lowercase. People and Spaces share one namespace, so a name is taken once. Resolved only through the directory's sealed record and the pinned key. */
export type VyreName = string;

/** The five fixed roles, strongest first. An admin may rename them for display; the ids never change. */
export type RoleId = 'owner' | 'admin' | 'manager' | 'member' | 'temp';

/**
 * What a role can do, as named abilities. A role is a bundle of grants whose `source` is `role:<id>`;
 * these names say which grants the bundle expands to. Per-project overrides may narrow a role, never widen it.
 */
export type RoleAbility =
  | 'space.delete' | 'space.move' | 'space.transfer' | 'space.root_key' | 'space.policy'
  | 'members.manage_all' | 'members.manage_below_admin'
  | 'devices.manage'
  | 'customize.definitions' // types, fields, stages, Flows, Kits
  | 'connectors.manage'
  | 'assistants.manage' // including @Engineer
  | 'projects.create_run' | 'projects.set_team_tasks_checkers' | 'projects.approve_inside' | 'kits.use'
  | 'projects.work_member_of' | 'space.shared_by_policy'
  | 'scoped.work'; // only the named projects or records, until expiry

export interface RoleBundle {
  readonly role: RoleId;
  readonly abilities: readonly RoleAbility[];
  /** Abilities the role never holds, whatever a per-project override says. */
  readonly never: readonly RoleAbility[];
  /** Temp only: a grant under this role must name projects or records and an expiry. */
  readonly requires_scope: boolean;
  /** Whether assistants may act for the holder without a further grant. Temp: no unless granted. */
  readonly assistants_act_for_holder: boolean;
}

/** A person's membership in one Space. Devices inherit their person's role there. */
export interface Membership {
  readonly space: SpaceId;
  /** The person actor id (`per_...`). */
  readonly person: string;
  readonly role: RoleId;
  /** Required for `temp`: the projects or record URNs the role reaches. */
  readonly scope?: readonly string[];
  /** Required for `temp`: when it ends. Extending is a grant change made with presence. */
  readonly expires?: Ms;
  readonly added_by: string;
  readonly added_at: Ms;
}

/** A Space is an identity: it claims a name in the same directory, signed by its root key held by its owners. */
export interface SpaceIdentity {
  readonly id: SpaceId;
  readonly name: VyreName;
  /** Own domains as aliases on top of the name (`app.example.com`); the vyre.run name stays the identity. */
  readonly aliases: readonly string[];
  /** Hash of the root key that signs the name claim, invites, Kits and shared views. */
  readonly root_key: string;
  /** The always-on machine where the Space runs. */
  readonly home?: string;
}
