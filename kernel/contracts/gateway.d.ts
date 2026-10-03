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
}

export interface AuditApi {
  verify(space: SpaceId): Promise<{ readonly ok: boolean; readonly events: number; readonly open_intents: number; readonly detail?: string }>;
}

/** The assembled kernel: the whole API of the kernel brief, section 4. */
export interface Kernel {
  authorize(input: AuthorizeInput): Promise<AuthorizeOutput>;
  readonly records: RecordsApi;
  readonly grants: GrantsApi;
  readonly ask: TaskApi;
  readonly model: ModelApi;
  readonly seal: SealApi;
  readonly events: EventsApi;
  readonly audit: AuditApi;
  health(): Promise<{ readonly ok: boolean; readonly versions: Readonly<Record<string, string>> }>;
}
