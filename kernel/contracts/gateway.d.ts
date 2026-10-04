// kernel/contracts/gateway.d.ts: the gateway's record calls and the assembled Kernel. Types only, no logic.
// Contract 3.1; the ten invariants of the kernel brief. Every call takes the kernel-built Chain as its first argument.

import type { Chain } from './chain.js';
import type { Labels, SpaceId, Urn } from './common.js';
import type { AuthorizeInput, AuthorizeOutput } from './authorize.js';
import type { GrantsApi } from './grant.js';
import type { EventsApi } from './event.js';
import type { AggregateRow, AggregateSpec, DefineDiff, DefineResult, Page, QuerySpec, RecordId, SearchHit, SearchSpec, StoredRecord } from './store.js';
import type { FieldValue } from './fields.js';
import type { TaskApi } from './task.js';
import type { ModelApi } from './model.js';
import type { SealApi } from './seal.js';

/** A record as the gateway returns it: shaped for the caller (placeholders for models and sinks), with labels. */
export interface GatewayRecord extends StoredRecord {
  readonly urn: Urn;
  readonly labels: Labels;
  /** Set when the stored version's hash did not match the event that wrote it (invariant 10): treat as untrusted. */
  readonly modified_outside?: boolean;
}

export interface RecordsApi {
  define(chain: Chain, diff: DefineDiff): Promise<DefineResult>;
  get(chain: Chain, type: string, id: RecordId): Promise<GatewayRecord | null>;
  query(chain: Chain, type: string, spec: QuerySpec): Promise<Page<GatewayRecord>>;
  aggregate(chain: Chain, type: string, spec: AggregateSpec): Promise<readonly AggregateRow[]>;
  search(chain: Chain, spec: SearchSpec): Promise<Page<SearchHit>>;
  /** The gateway mints the id (a time-prefixed UUID) and the store keeps it. Writes an intent first and one event after. */
  create(chain: Chain, type: string, data: Readonly<Record<string, FieldValue>>): Promise<GatewayRecord>;
  update(chain: Chain, type: string, id: RecordId, patch: Readonly<Record<string, FieldValue>>, base_version: number): Promise<GatewayRecord>;
  remove(chain: Chain, type: string, id: RecordId, base_version: number): Promise<GatewayRecord>;
  restore(chain: Chain, type: string, id: RecordId): Promise<GatewayRecord>;
  /** Every role the holder (a contact or organization urn) has or had, current first. Only rows the caller may read; a holder the caller may not read has none. */
  roles(chain: Chain, holder: Urn, opts?: { readonly include_ended?: boolean }): Promise<readonly RoleHold[]>;
  /** The holders of one role type, optionally at one stage (ended roles left out unless `include_ended`). */
  holders(chain: Chain, spec: { readonly role: string; readonly stage?: string; readonly include_ended?: boolean; readonly page: { readonly limit: number; readonly cursor?: string } }): Promise<Page<RoleHold>>;
  /**
   * Merge two records of one type that are one (two contacts for one person): `drop` goes to the bin, `keep` takes what it lacked, links to `drop` move to `keep`.
   * Sealed values stay with the dropped record (`sealed_left`); different values are reported in `conflicts` (a unique field's other value goes to `other_<field>s` when the type has it).
   * Checked and logged through the record calls; one `records.merged` event with `merge_id`.
   */
  merge(chain: Chain, type: string, keep: RecordId, drop: RecordId): Promise<{ readonly keep: GatewayRecord | null; readonly dropped: Urn; readonly relinked: number; readonly conflicts: Readonly<Record<string, FieldValue>>; readonly sealed_left: readonly string[]; readonly merge_id: string }>;
  /** Undo a merge: fields the merge set go back unless edited since, the dropped record is restored, links point at it again. Once per merge. */
  unmerge(chain: Chain, merge_id: string): Promise<{ readonly keep: GatewayRecord | null; readonly restored: Urn; readonly relinked: number; readonly edited_since: readonly string[] }>;
}

/** A role record seen from its holder. `current` is false for a removed record or one in an ended stage. */
export interface RoleHold {
  readonly role: string;
  readonly holder: Urn;
  readonly stage?: string;
  readonly current: boolean;
  readonly record: GatewayRecord;
}

export interface AuditApi {
  verify(space: SpaceId): Promise<{ readonly ok: boolean; readonly events: number; readonly open_intents: number; readonly detail?: string }>;
}

/** The assembled kernel: the whole API of the kernel brief, section 4. */
export interface Kernel {
  authorize(input: AuthorizeInput): Promise<AuthorizeOutput>;
  readonly records: RecordsApi;
  /** Operations that change what a field is under existing data. */
  readonly migrate: {
    /** Seal a plain text field that holds values: they move into a new sealed field `<field>_sealed` through seal.put, the plain field is removed from view, and the old values are scrubbed from the store's change log and snapshots, Twenty's timeline and the event log (an erased event keeps its envelope). Needs records.define, records.update and seal.put. */
    sealField(chain: Chain, input: { readonly type: string; readonly field: string; readonly class: string; readonly level?: 'ai' | 'human'; readonly name?: string; readonly scrub_history?: boolean }): Promise<{ readonly sealed_field: string; readonly moved: number; readonly erased_events: number }>;
  };
  readonly grants: GrantsApi;
  readonly ask: TaskApi;
  readonly model: ModelApi;
  readonly seal: SealApi;
  readonly events: EventsApi;
  readonly audit: AuditApi;
  health(): Promise<{ readonly ok: boolean; readonly versions: Readonly<Record<string, string>> }>;
}
