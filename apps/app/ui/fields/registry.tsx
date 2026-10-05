// The one registry of field kinds (ui-primitives.md section 4): for each kind of the kernel, a display renderer, an edit renderer, filter ops, a test and a sort key.
// No screen draws a field any other way: list, board, calendar and the record page all call renderField (to show) or editField (to change).
//   renderField(props, env)   the value as it reads, in view or compact mode; a sealed value is drawn by the sealed renderer whatever the field's kind
//   editField(props, env)     the edit renderer; it calls props.onChange with the value to save (undefined for a sealed field until the person types)
import type { ReactElement } from "react";
import { Text } from "../components/Text";
import { View } from "react-native";
import * as D from "./display";
import * as E from "./editors";
import { SealedEdit, SealedView } from "./Sealed";
import { KIND_LOGIC, PICKABLE_KINDS, isSealedValue, normalizeKind } from "./logic.js";
import type { EditProps, FieldEnv, FieldProps, ViewProps } from "./types";

type Kind = {
  label: string;
  view: (p: ViewProps) => ReactElement;
  edit: (p: EditProps) => ReactElement;
  ops: { id: string; label: string; operand: string }[];
  test: (op: string, a: any, v: any, ctx?: any) => boolean;
  sort: (v: any, ctx?: any) => string | number | null;
};

const L = KIND_LOGIC;
const make = (kind: keyof typeof KIND_LOGIC, view: Kind["view"], edit: Kind["edit"]): Kind => ({ ...L[kind], view, edit });

/** Every kind of the kernel (kernel/contracts/fields.d.ts FieldKind), keyed by its kernel name. */
export const registry: Record<string, Kind> = {
  text: make("text", D.TextView, E.TextEdit),
  url: make("url", D.UrlLinkView, E.TextEdit),
  rich_text: make("rich_text", D.RichTextView, E.RichTextEdit),
  number: make("number", D.NumberView, E.NumberEdit),
  money: make("money", D.MoneyView, E.MoneyEdit),
  boolean: make("boolean", D.BooleanView, E.BooleanEdit),
  date: make("date", D.DateView, E.DateEdit),
  datetime: make("datetime", D.DateTimeView, E.DateTimeEdit),
  choice: make("choice", D.ChoiceView, E.ChoiceEdit),
  multi_choice: make("multi_choice", D.MultiChoiceView, E.MultiChoiceEdit),
  rating: make("rating", D.RatingView, E.RatingEdit),
  link: make("link", D.LinkView, E.LinkEdit),
  ref: make("ref", D.LinkView, E.LinkEdit),
  actor: make("actor", D.ActorView, E.ActorEdit),
  file: make("file", D.FileView, E.FileEdit),
  address: make("address", D.AddressView, E.AddressEdit),
  phones: make("phones", D.PhoneView, E.PhoneEdit),
  emails: make("emails", D.EmailView, E.EmailEdit),
  urls: make("urls", D.UrlView, E.UrlEdit),
  stage: make("stage", D.StageView, E.StageEdit),
  sealed: make("sealed", SealedView, SealedEdit),
};

/** The kinds a person picks in Add a field: the fifteen, as [kernel kind, label]. */
export const KINDS: [string, string][] = PICKABLE_KINDS as [string, string][];

const kindOf = (kind: string) => registry[normalizeKind(kind)] || registry.text;

/** The view of a field. */
export function renderField(p: FieldProps, env: FieldEnv = {}): ReactElement {
  const k = kindOf(p.kind);
  const sealed = isSealedValue(p.value) && normalizeKind(p.kind) !== "sealed";
  const V = (sealed ? registry.sealed : k).view;
  const body = <V p={p} env={env} />;
  return p.error ? <View className="gap-s1">{body}<Text size="caption" tone="err" accessibilityRole="alert">{p.error}</Text></View> : body;
}

/** The edit form of a field. A sealed value is never prefilled: its editor starts empty and says nothing until the person types. */
export function editField(p: FieldProps, env: FieldEnv = {}): ReactElement {
  const sealed = isSealedValue(p.value) && normalizeKind(p.kind) !== "sealed";
  const k = sealed ? registry.sealed : kindOf(p.kind);
  const E = k.edit;
  const body = <E p={p} env={env} emit={(v) => p.onChange?.(v)} />;
  return p.error ? <View className="gap-s1">{body}<Text size="caption" tone="err" accessibilityRole="alert">{p.error}</Text></View> : body;
}

export { filterOps, matches, sortKey, sortRows, kindLabel, isEmpty, isSealedValue, fmtDate, fmtMoney, addrText, toDate, isoDay } from "./logic.js";
