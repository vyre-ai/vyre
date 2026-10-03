// kernel/contracts/fields.d.ts: field kinds, values, type definitions and the field-renderer props. Types only, no logic.
// Contract 5.2 and 8; the UI builds field renderers against FieldRendererProps.

import type { Uuid, Ms, Urn } from './common.js';
import type { Actor } from './chain.js';

/** The fixed set of field kinds (contract 5.2). Twenty has 25; ours is the language's, and a store translates. */
export type FieldKind =
  | 'text' | 'rich_text' | 'number' | 'money' | 'boolean' | 'date' | 'datetime' | 'choice' | 'multi_choice'
  | 'rating' | 'url' | 'link' | 'actor' | 'file' | 'address' | 'phones' | 'emails' | 'urls' | 'stage' | 'sealed';

export interface Money { readonly amount: number; readonly currency: string }
export interface Address { readonly line1?: string; readonly line2?: string; readonly city?: string; readonly region?: string; readonly postal?: string; readonly country?: string }

/**
 * What a record holds in place of a sealed value: a reference plus placeholder metadata (contract 8.3).
 * This is also what a model sees, and what every store, log, index and export holds. Never a value.
 */
export interface SealedRefValue {
  readonly sealed: string;
  readonly ref: string;
  readonly present: boolean;
  readonly valid_format: boolean;
  readonly set_at: Ms;
  /** Only if the field's seal config allows it, for example "last4". Default off. */
  readonly hint?: string;
}

/** A placeholder the kernel substitutes for a sealed value in a model-facing view (no `ref`). */
export interface SealedPlaceholder { readonly sealed: string; readonly present: boolean; readonly valid_format: boolean }

export type FieldValue =
  | null | string | number | boolean | Money | Address | readonly string[] | readonly Address[]
  | { readonly urn: Urn }                 // link
  | { readonly actor: Actor }             // actor
  | { readonly file: string; readonly name: string; readonly bytes: number }
  | SealedRefValue | SealedPlaceholder;

export interface SealConfig {
  /** `ai`: no model ever; humans per grant. `human`: only the reveal roles, each reveal with fresh presence (contract 8.2). */
  readonly level: 'ai' | 'human';
  readonly class: string;
  readonly reveal_roles?: readonly string[];
  readonly hint_allowed?: boolean;
}

export interface FieldDefinition {
  readonly name: string;
  readonly kind: FieldKind;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
  /** For `choice`, `multi_choice` and `stage`. */
  readonly options?: readonly string[];
  /** For `link` (a reference to another record): the target record type. */
  readonly to?: string;
  readonly seal?: SealConfig;
  /** Among the type's live records no two hold the same non-null value. Kinds text, number, url, choice, date, datetime. A store enforces it atomically (store error `unique_violation`). */
  readonly unique?: boolean;
}

export interface TaskTemplateDef {
  readonly title: string;
  readonly doer: string;
  readonly checker?: string;
  readonly output: { readonly kind: 'fields' | 'note' | 'draft' | 'sent' | 'decision' | 'file'; readonly target?: string };
  readonly how?: 'template' | 'tailor' | 'assistant' | 'person';
  readonly template?: string;
  readonly depends_on?: readonly string[];
  readonly due_offset_ms?: Ms;
  readonly required?: boolean;
}

export interface StageDef { readonly name: string; readonly tasks?: readonly TaskTemplateDef[] }

export interface TypeDefinition {
  readonly name: string;
  readonly label: string;
  readonly icon?: string;
  readonly fields: readonly FieldDefinition[];
  readonly stages?: readonly StageDef[];
  /** Expression strings in the Expression language, validated, never code. */
  readonly rules?: readonly { readonly name?: string; readonly require: string }[];
}

/** How a field is shown. */
export type RenderMode = 'view' | 'edit' | 'compact';

/**
 * The props every field renderer receives (the UI team builds one component per FieldKind against this).
 * A renderer never sees a sealed value unless the person has just revealed it, and a reveal arrives through
 * `reveal` as an explicit, human-only action (invariant 4).
 */
export interface FieldRendererProps<K extends FieldKind = FieldKind> {
  readonly kind: K;
  readonly definition: FieldDefinition;
  readonly value: FieldValue;
  readonly mode: RenderMode;
  readonly read_only: boolean;
  readonly error?: string;
  /** Provenance of the value, shown on hover: who set it and from which source. */
  readonly source?: { readonly actor?: string; readonly trust?: 'system' | 'member' | 'external' | 'untrusted'; readonly at?: Ms };
  onChange?(value: FieldValue): void;
  /** For a `sealed` field: ask the kernel to reveal on the person's screen only. Resolves after fresh presence. */
  reveal?(purpose: string): Promise<string>;
  onFocus?(): void;
  onBlur?(): void;
}
