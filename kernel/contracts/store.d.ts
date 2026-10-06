// kernel/contracts/store.d.ts: the store interface every store implements. Types only, no logic.
// Contract 3.2 and 3.5; invariant 10. The conformance suite (kernel/conformance) is the definition of "a store".

import type { Uuid, Ms, B64 } from './common.js';
import type { FieldKind, FieldValue, TypeDefinition } from './fields.js';

export type RecordId = Uuid;

/** One stored record version. `data` never contains a sealed value, only a SealedRefValue (invariant 5). */
export interface StoredRecord {
  readonly type: string;
  readonly id: RecordId;
  readonly version: number;
  readonly data: Readonly<Record<string, FieldValue>>;
  readonly created_at: Ms;
  readonly updated_at: Ms;
  readonly deleted_at?: Ms;
}

/** A definition change set the store applies idempotently and reports back. */
export interface DefineDiff {
  readonly add_types?: readonly TypeDefinition[];
  readonly change_types?: readonly TypeDefinition[];
  readonly remove_types?: readonly string[];
}

export interface DefineResult {
  readonly applied: boolean;
  /** Plain description of what changed; empty when the diff was already applied. */
  readonly changes: readonly string[];
}

export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains' | 'is_null';

export type Filter =
  | { readonly and: readonly Filter[] }
  | { readonly or: readonly Filter[] }
  | { readonly not: Filter }
  | { readonly field: string; readonly op: FilterOp; readonly value?: FieldValue | readonly FieldValue[] };

export interface Sort { readonly field: string; readonly dir: 'asc' | 'desc' }

/** Cursor paging, never offsets: the spike's prototype returned 100 rows with no cursor. */
export interface PageRequest { readonly limit: number; readonly cursor?: string }
export interface Page<T> { readonly rows: readonly T[]; readonly next_cursor?: string; readonly total_visible?: number }

export interface QuerySpec {
  readonly filter?: Filter;
  readonly sort?: readonly Sort[];
  readonly page: PageRequest;
  readonly include_deleted?: boolean;
}

export interface AggregateSpec {
  readonly filter?: Filter;
  readonly group_by?: readonly string[];
  readonly measures: readonly { readonly fn: 'count' | 'sum' | 'min' | 'max' | 'avg'; readonly field?: string }[];
}

export interface AggregateRow {
  readonly group: Readonly<Record<string, FieldValue>>;
  readonly values: Readonly<Record<string, number | null>>;
}

export interface SearchSpec { readonly text: string; readonly types?: readonly string[]; readonly page: PageRequest }
export interface SearchHit { readonly type: string; readonly id: RecordId; readonly score: number; readonly snippet?: string }

/** What changed inside the store on its own (mail sync, imports): reported as coming from the store, never trusted as the gateway's. */
export interface ChangeEntry {
  readonly cursor: string;
  readonly type: string;
  readonly id: RecordId;
  readonly kind: 'created' | 'updated' | 'removed' | 'restored';
  readonly version: number;
  readonly at: Ms;
  /** Present only if the store has it. A webhook-backed store usually has no "before" (the Twenty spike). */
  readonly before?: Readonly<Record<string, FieldValue>>;
  readonly after?: Readonly<Record<string, FieldValue>>;
}

export interface StoreFeatures {
  readonly aggregate: boolean;
  readonly search: boolean;
  readonly changes: boolean;
  readonly cursor_paging: true;
}

export interface StoreHealth {
  readonly ok: boolean;
  readonly detail?: string;
  readonly checked_at: Ms;
}

export interface StoreVersion {
  readonly store: string;
  readonly version: string;
  /** The conformance suite revision this store last passed. */
  readonly conformance?: number;
}

export interface ExportChunk { readonly seq: number; readonly records: readonly StoredRecord[]; readonly done: boolean; readonly checksum: B64 }

export type StoreErrorCode =
  | 'not_found' | 'version_conflict' | 'invalid' | 'unknown_type' | 'unknown_field' | 'unsupported'
  | 'unavailable' | 'id_mismatch' | 'sealed_value_refused';

export interface StoreError { readonly code: StoreErrorCode; readonly message: string }

/**
 * The store interface. Small on purpose. Our ids, our definitions, our value kinds: a store translates.
 * A store is never trusted to enforce who may see what (invariant 10): the gateway adds the grant's selector to every
 * query and checks each returned row and field itself. `update` carries the version the caller read, so concurrent
 * edits fail with `version_conflict` instead of overwriting.
 */
export interface Store {
  define(diff: DefineDiff): Promise<DefineResult>;
  /** Every type definition the store holds (the tool surface and Customize list from here). */
  types(): Promise<readonly TypeDefinition[]>;
  /** The field names and kinds of a type, or null: the gateway reads which fields are sealed from here and refuses model queries on them. */
  /** Optional. Forget the values these fields held everywhere the store kept them (its change log, snapshots, any history of its own): a field was sealed. */
  scrub?(type: string, fields: readonly string[], ids?: ReadonlySet<string>): Promise<void>;
  describe(type: string): Promise<{ readonly name: string; readonly fields: readonly { readonly name: string; readonly kind: FieldKind }[] } | null>;
  get(type: string, id: RecordId, opts?: { readonly include_deleted?: boolean }): Promise<StoredRecord | null>;
  query(type: string, spec: QuerySpec): Promise<Page<StoredRecord>>;
  aggregate(type: string, spec: AggregateSpec): Promise<readonly AggregateRow[]>;
  /** The id is minted by the gateway and kept: a store that returns a different id fails conformance. */
  create(type: string, id: RecordId, data: Readonly<Record<string, FieldValue>>): Promise<StoredRecord>;
  update(type: string, id: RecordId, patch: Readonly<Record<string, FieldValue>>, base_version: number): Promise<StoredRecord>;
  remove(type: string, id: RecordId, base_version: number): Promise<StoredRecord>;
  restore(type: string, id: RecordId): Promise<StoredRecord>;
  search(spec: SearchSpec): Promise<Page<SearchHit>>;
  changes(since: string | null, limit: number): Promise<{ readonly entries: readonly ChangeEntry[]; readonly cursor: string }>;
  health(): Promise<StoreHealth>;
  version(): Promise<StoreVersion>;
  export(since?: string): AsyncIterable<ExportChunk>;
  features(): StoreFeatures;
}
