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
  /** Removed from view, data kept: nothing reads, writes, filters or searches it, and it is never required. Set it back to false and the data is there again. Deleting for good is a migration. */
  readonly hidden?: boolean;
  /** Roles (owner, admin, manager, member, temp, or a Kit's own) that never see this field: not on a read, a list, a filter, a total or a search, and not writable by them. */
  readonly hidden_from?: readonly string[];
  /**
   * Worked out when a record is read, never stored, never written, never filtered on; a number, text, boolean, date or datetime field. Either an Expression over this
   * type's other stored fields (`days_since(last_contact)`), or a total over the records of another type that link here (`over`: `{ type: "matter", via: "client", fn: "sum",
   * field: "fee.amount" }`, `where` an optional filter). A reader who cannot see everything it is made from gets no value.
   */
  /** Shown only while this Expression, over the record's other stored fields, is true (`practice_area == "Personal Injury"`). Not shown means not editable and not written: the value is kept, and shows again when the condition holds. Never together with `required`. */
  readonly visible_if?: string;
  /** Required only while this Expression is true and the field is visible (`stage == "Signed"`). A write that leaves it empty then is refused. Never together with `required`. */
  readonly required_if?: string;
  /** Written only by the named service (`kernel`: the tasks service, for a task's status); a write by any other chain is refused. The type says so, the gateway enforces it. */
  readonly owned_by?: 'kernel';
  readonly computed?: { readonly expr: string } | { readonly over: { readonly type: string; readonly via: string; readonly fn: 'count' | 'sum' | 'min' | 'max' | 'avg'; readonly field?: string; readonly where?: unknown } };
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

export interface StageDef {
  readonly name: string;
  readonly tasks?: readonly TaskTemplateDef[];
  /** The record can enter this stage only while this Expression, over the record as it would be after the write, is true. */
  readonly enter_if?: string;
}

/** A stage set: the stages a record follows while `when` holds for it. The first set that holds wins; the type's `stages` are the default set. */
export interface StageSetDef { readonly name: string; readonly when: string; readonly stages: readonly StageDef[] }

/** How a type is shown, stored with the type. `columns` are field names; a `board` groups by a choice or stage field and shows `columns` on its cards. */
export interface ViewDef {
  readonly name: string;
  readonly type: 'list' | 'board' | 'calendar' | 'page' | 'dashboard';
  readonly label?: string;
  readonly groupBy?: string;
  readonly dateField?: string;
  readonly columns?: readonly string[];
  /** An Expression over the record's stored fields; only records it is true for are shown. */
  readonly filter?: string;
  readonly sort?: { readonly field: string; readonly dir?: 'asc' | 'desc' };
}

export interface TypeDefinition {
  readonly name: string;
  readonly label: string;
  readonly icon?: string;
  /** "project" marks a type that holds work (the app shows it as a project); anything else is refused. Left out for a plain type. */
  readonly kind?: 'project';
  readonly fields: readonly FieldDefinition[];
  /** The default stages. The stage field's options are every stage name of these and of the `stage_sets`. */
  readonly stages?: readonly StageDef[];
  /** Stage sets that vary by a value on the record (a personal-injury case and an estate-planning case on one type follow different stages). */
  readonly stage_sets?: readonly StageSetDef[];
  /** How the type is shown. The app reads these; its own table is only the default for a type that has none. */
  readonly views?: readonly ViewDef[];
  /** Expression strings in the Expression language, validated, never code. */
  readonly rules?: readonly { readonly name?: string; readonly require: string }[];
  /**
   * Marks the type as a role: what a contact or an organization is to the Space (prospect, client, ambassador). `link` names the one required link field
   * (to `contact` or `organization`) that says who holds it. `ended` lists the stages that mean the role is over (it stays a record, it is just not current).
   */
  readonly role?: { readonly link: string; readonly ended?: readonly string[] };
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
