import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { Avatar, type AvatarFamily } from "../components/Avatar";
import { addrText, actorIdOf, fmtDate, fmtMoney, fmtTime, isEmpty, listOf, marks, relDate, toDate, urnOf } from "./logic.js";
import type { ViewProps } from "./types";

const Empty = () => <Text tone="faint">Empty</Text>;
const str = (v: any) => (typeof v === "object" && v ? String(v.name ?? v.title ?? "") : String(v ?? ""));
const TABULAR = { fontVariant: ["tabular-nums" as const] };

export const familyOf = (f?: string): AvatarFamily => (f === "assistant" ? "assistant" : f === "teammate" ? "teammate" : f === "service" ? "agent" : "person");

export function TextView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text numberOfLines={p.mode === "compact" ? 1 : undefined}>{str(p.value)}</Text>;
}

export function RichTextView({ p }: ViewProps) {
  if (isEmpty(p.value)) return <Empty />;
  return (
    <Text numberOfLines={p.mode === "compact" ? 2 : undefined}>
      {marks(str(p.value)).map((m, i) => (m.br ? "\n" : <Text key={i} strong={m.bold} style={m.italic ? { fontStyle: "italic" } : undefined}>{m.text}</Text>))}
    </Text>
  );
}

export function NumberView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text style={TABULAR}>{String(p.value)}</Text>;
}

export function MoneyView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text style={TABULAR}>{fmtMoney(p.value)}</Text>;
}

export function BooleanView({ p }: ViewProps) {
  return p.value === null || p.value === undefined ? <Empty /> : <Chip tone={p.value ? "ok" : "plain"}>{p.value ? "Yes" : "No"}</Chip>;
}

export function DateView({ p, env }: ViewProps) {
  const d = fmtDate(p.value, env.now);
  return d ? <Text accessibilityLabel={`${d}, ${relDate(p.value, env.now)}`}>{d}</Text> : <Empty />;
}

export function DateTimeView({ p, env }: ViewProps) {
  return toDate(p.value) ? <Text accessibilityLabel={relDate(p.value, env.now)}>{`${fmtDate(p.value, env.now)}, ${fmtTime(p.value)}`}</Text> : <Empty />;
}

export function ChoiceView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Chip>{str(p.value)}</Chip>;
}

export function MultiChoiceView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <View className="flex-row flex-wrap gap-s1">{listOf(p.value).map((x) => <Chip key={x}>{x}</Chip>)}</View>;
}

/** A strip of marks, one per stage, filled up to the current one, then the stage's name. */
export function StageView({ p }: ViewProps) {
  if (isEmpty(p.value)) return <Empty />;
  const st = [...(p.definition.options || [])], at = st.indexOf(p.value);
  return (
    <View className="gap-s1" accessibilityLabel={`${str(p.value)}, stage ${at + 1} of ${st.length}`}>
      <View className="flex-row gap-s1">{st.map((s, j) => <View key={s} className={j <= at ? "h-s1 w-s3 rounded-full bg-accent" : "h-s1 w-s3 rounded-full bg-edge-strong"} />)}</View>
      <Text numberOfLines={1}>{str(p.value)}</Text>
    </View>
  );
}

export function RatingView({ p }: ViewProps) {
  const n = Math.max(0, Math.min(5, Math.round(Number(p.value))));
  if (!n) return <Empty />;
  return (
    <View accessibilityRole="image" accessibilityLabel={`${n} of 5`} className="flex-row">
      {[1, 2, 3, 4, 5].map((i) => <Text key={i} tone={i <= n ? "accent" : "faint"}>{"★"}</Text>)}
    </View>
  );
}

/** A link or a reference to another record: an accent chip with its title; polymorphic links show the target's type. */
export function LinkView({ p, env }: ViewProps) {
  if (isEmpty(p.value)) return <Empty />;
  const urn = urnOf(p.value), t = env.links?.[urn];
  const title = t ? t.title : urn.split("/").pop() || urn;
  const chip = <Chip tone="accent">{title}</Chip>;
  const typed = t?.type && t.type !== p.definition.to ? <Text size="caption" tone="label">{t.type}</Text> : null;
  return (
    <View className="flex-row flex-wrap items-center gap-s2">
      {env.open ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${title}`} onPress={() => env.open?.(urn)}>{chip}</Pressable> : chip}
      {typed}
    </View>
  );
}

export function ActorView({ p, env }: ViewProps) {
  if (isEmpty(p.value)) return <Empty />;
  const id = actorIdOf(p.value), a = (env.actors || []).find((x) => x.id === id);
  const name = a ? a.name : p.value?.actor?.name || id;
  return (
    <View className="flex-row items-center gap-s2">
      <Avatar name={name} family={familyOf(a?.family)} size="sm" />
      <Text numberOfLines={1} className="min-w-0 flex-shrink">{name}</Text>
    </View>
  );
}

export function FileView({ p }: ViewProps) {
  const f = p.value;
  return isEmpty(f) ? <Empty /> : <Chip icon="file">{String(f.name || f.file)}</Chip>;
}

export function AddressView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text>{addrText(p.value)}</Text>;
}

export function PhoneView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text mono>{listOf(p.value).join(", ")}</Text>;
}

export function EmailView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <Text tone="accent">{listOf(p.value).join(", ")}</Text>;
}

export function UrlView({ p }: ViewProps) {
  return isEmpty(p.value) ? <Empty /> : <View className="flex-row items-center gap-s1"><Icon name="link" /><Text tone="accent">{listOf(p.value).join(", ")}</Text></View>;
}
