// kernel/contracts/event.d.ts: the event envelope and the log. Types only, no logic.
// Contract 7; invariant 7.

import type { SpaceId, Uuid, Ms, B64, Urn, TrustLabel, RedactionClass, Visibility } from './common.js';
import type { Hop } from './chain.js';

/** `noun.past-verb`, exactly two segments, lowercase and hyphen. Declared by a manifest or a definition. */
export type EventType = string;

export interface Provenance {
  readonly agent?: string;
  readonly tool?: string;
  readonly model?: string;
  readonly input_hash?: B64;
  readonly decision?: string;
}

/** Record events carry the diff; sealed fields appear as `{ sealed: true, changed: true }`, never a value. */
export interface RecordDiff {
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
  readonly changed: readonly string[];
  /** Hash of the new record version; verified on read (invariant 10). Covers only gateway-written fields. */
  readonly version_hash?: B64;
}

/** The one envelope for every event (contract 7.1). It extends today's `events` row; it does not replace it. */
export interface EventEnvelope<Data = unknown> {
  readonly v: 1;
  /** Time-prefixed UUID minted by the emitter. */
  readonly id: Uuid;
  /** Position in this Space's log: today's integer id. The cursor and the order. */
  readonly seq: number;
  readonly space: SpaceId;
  readonly type: EventType;
  /** Schema version of this type. */
  readonly sv: number;
  /** Claimed time: not used for ordering. */
  readonly time: Ms;
  /** The home's own clock when appended: conditions, schedules and retention use this. */
  readonly received_at: Ms;
  /** The chain's last hop as `<kind>:<id>@<space>`, and the full chain. */
  readonly actor: string;
  readonly chain: readonly Hop[];
  readonly via?: { readonly node?: string; readonly surface?: string; readonly device?: string; readonly session?: string };
  readonly subject: Urn;
  /** The event or decision that caused this one. */
  readonly cause?: Uuid | string;
  /** The thread, Flow run or workflow. */
  readonly corr?: Uuid | string;
  readonly prov?: Provenance;
  readonly trust: TrustLabel;
  /** Every Space the content came from (multi-Space contexts). */
  readonly source_spaces: readonly SpaceId[];
  readonly vis: Visibility;
  readonly red: RedactionClass;
  readonly data: Data;
  /** H(salt || canonical data). The salt is kept beside the data and erased with it, so erasure leaves no dictionary oracle. */
  readonly commit: B64;
  readonly prev: B64;
  /** Over the envelope with `data` replaced by `commit`, `prev` included. */
  readonly hash: B64;
  /** Only when the event crossed a node. */
  readonly sig?: B64;
}

/** What a caller of `events.append` (kernel-internal) supplies. The kernel fills the rest. */
export interface NewEvent<Data = unknown> {
  readonly type: EventType;
  readonly sv: number;
  readonly subject: Urn;
  readonly data: Data;
  readonly cause?: string;
  readonly corr?: string;
  readonly prov?: Provenance;
  readonly vis?: Visibility;
  readonly red?: RedactionClass;
}

/** Written before the store call and completed after it, so a crash never loses who did it (3.1, invariant 7). */
export interface Intent {
  readonly id: Uuid;
  readonly decision: string;
  readonly chain: readonly Hop[];
  readonly record: Urn;
  readonly base_version: number | null;
  readonly operation: 'create' | 'update' | 'remove' | 'restore' | 'define';
  readonly input_hash: B64;
  readonly state: 'open' | 'completed' | 'compensated';
  readonly started_at: Ms;
}

/** Signed every 1,000 events or 10 minutes; the person's device holds the latest (K5). */
export interface Checkpoint {
  readonly space: SpaceId;
  readonly seq: number;
  readonly hash: B64;
  readonly time: Ms;
  readonly key_id: string;
  readonly sig: B64;
}

export interface EventFilter {
  /** Exact type, `noun.*`, or `*`. */
  readonly type?: string;
  readonly subject_prefix?: Urn;
  readonly corr?: string;
  readonly actor?: string;
  readonly since?: number;
  readonly limit?: number;
}

/** At-least-once, with a durable named cursor per consumer; consumers are idempotent on `id`. */
export interface EventsApi {
  read(chain: import('./chain.js').Chain, filter: EventFilter): Promise<readonly EventEnvelope[]>;
  subscribe(chain: import('./chain.js').Chain, consumer: string, filter: EventFilter, onEvent: (e: EventEnvelope) => Promise<void> | void): () => void;
  latestSeq(space: SpaceId): Promise<number>;
}
