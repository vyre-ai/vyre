// The second tier of blocks: calendar, stages, people, activity, approval, gallery, map and filter. Same rules as BlockViews: read the block's own content, take spacing and colour from components.
import { useState } from "react";
import { Image, View } from "react-native";
import { Avatar } from "../components/Avatar";
import { AskCard } from "../components/AskCard";
import { Card, Divider } from "../components/Card";
import { Field } from "../components/Field";
import { FilterPills } from "../components/FilterPills";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import { StageMini } from "../components/StageSteps";
import { EmptyState } from "../components/States";
import { Text } from "../components/Text";
import { markRef } from "../marks/useMark";
import { useUiTheme } from "../theme";
import { TimelineBlock } from "./BlockViews";
import type { Block, Handlers } from "./types";

type P = { k: string; b: Block; h: Handlers };
const c = (b: Block) => b.content ?? {};
const rows = (x: any): any[] => (Array.isArray(x) ? x : []);
const more = (n?: number) => (n ? <Text size="caption" tone="label">{`${n} more`}</Text> : null);

/** Dated items as an agenda: a heading per day, the items under it in the order given. (A month grid is a later form; the agenda reads on every width.) */
export function CalendarBlock({ b }: P) {
  const ev = rows(c(b).events);
  if (!ev.length) return <EmptyState title={c(b).empty || "Nothing on the calendar."} />;
  const days: Record<string, any[]> = {};
  for (const e of [...ev].sort((x, y) => String(x.date).localeCompare(String(y.date)))) (days[String(e.date)] ??= []).push(e);
  return (
    <View className="gap-s3">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      {Object.entries(days).map(([d, list]) => (
        <View key={d} className="gap-s2">
          <Text size="caption" tone="label">{d}</Text>
          <Card flush>{list.map((e, i) => <View key={e.id ?? i}>{i > 0 ? <Divider /> : null}<Row title={String(e.title)} sub={e.subtitle} /></View>)}</Card>
        </View>
      ))}
      {more(c(b).more)}
    </View>
  );
}

/** The steps of a process: done, current, to come. A bar and a word each, so colour is never the only signal. (Drawn here with plain heights: the shared StageSteps strip collapses to no height in a block column.) */
export function StagesBlock({ b }: P) {
  const steps = rows(c(b).steps), idx = Math.max(0, steps.findIndex((s) => s.id === c(b).current));
  const { phone, color } = useUiTheme();
  if (!steps.length) return null;
  const names = steps.map((s) => String(s.title));
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      {phone ? <StageMini stages={names} current={idx} /> : (
        <View accessibilityRole="list" className="flex-row gap-s2">
          {names.map((n, i) => (
            <View key={n} accessibilityLabel={n} accessibilityState={{ selected: i === idx }} className="min-w-0 flex-1 gap-s1">
              <View style={{ height: 4, borderRadius: 2, backgroundColor: i < idx ? color.ok : i === idx ? color.accent : color["edge-strong"] }} />
              <Text size="caption" strong={i === idx} tone={i > idx ? "label" : i < idx ? "muted" : "default"} numberOfLines={1}>{n}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function PeopleBlock({ b }: P) {
  const ps = rows(c(b).people);
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <Card flush>
        {ps.map((p, i) => (
          <View key={p.id ?? i}>{i > 0 ? <Divider /> : null}<Row lead={<Avatar of={markRef("person", String(p.name), String(p.id ?? p.name))} size={32} />} title={String(p.name)} sub={p.role} /></View>
        ))}
      </Card>
      {more(c(b).more)}
    </View>
  );
}

export function ActivityBlock(p: P) { return <TimelineBlock {...p} />; }

/** Something that needs a yes: the exact words, then the answer. It is the hero card and never shrinks. The block's actions are the answers; the first is the primary. */
export function ApprovalBlock({ k, b, h }: P) {
  const words = rows(c(b).words);
  return (
    <AskCard title={String(c(b).title ?? b.props?.title ?? "Needs your yes")} why={c(b).from ? `From ${c(b).from}` : undefined}
      actions={(b.actions ?? []).map((a, i) => ({ label: a.title, kind: i === 0 ? "primary" : "ghost", onPress: () => h.act?.(k, a.id) }))}>
      {words.length ? <View className="gap-s2">{words.map((w, i) => <View key={`${w.label}${i}`}><Text size="caption" tone="label">{w.label}</Text><Text>{String(w.value)}</Text></View>)}</View> : null}
    </AskCard>
  );
}

export function GalleryBlock({ k, b, h }: P) {
  const tiles = rows(c(b).tiles), cols = b.props?.cols ?? 3;
  if (!tiles.length) return <EmptyState title={c(b).empty || "Nothing here yet."} />;
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <View className="flex-row flex-wrap gap-s3">
        {tiles.map((t, i) => (
          <View key={t.id ?? i} style={{ flexGrow: 0, flexBasis: `${Math.floor(100 / cols) - 3}%`, minWidth: 96, maxWidth: 280 }}>
            <Card flush onTouchEnd={h.open ? () => h.open!(k, t) : undefined}>
              {t.url ? <Image source={{ uri: String(t.url) }} accessibilityLabel={String(t.title)} style={{ width: "100%", aspectRatio: 4 / 3 }} resizeMode="cover" /> : <View style={{ aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center" }} className="bg-surface-3"><Text size="title" tone="faint">{String(t.title).slice(0, 1).toUpperCase()}</Text></View>}
              <View className="p-s3"><Text numberOfLines={1}>{String(t.title)}</Text></View>
            </Card>
          </View>
        ))}
      </View>
      {more(c(b).more)}
    </View>
  );
}

/** Places as a list with their coordinates. A drawn map needs a map library the app does not carry yet; the list is the honest form until it does. */
export function MapBlock({ b }: P) {
  const pins = rows(c(b).pins);
  if (!pins.length) return <EmptyState title={c(b).empty || "No places yet."} />;
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <Card flush>{pins.map((p, i) => <View key={p.id ?? i}>{i > 0 ? <Divider /> : null}<Row title={String(p.title)} sub={p.lat && p.lng ? `${p.lat}, ${p.lng}` : undefined} /></View>)}</Card>
      {more(c(b).more)}
    </View>
  );
}

/** Search and pills for the blocks beside it. The host answers by asking again with the words (handlers.filter). */
export function FilterBlock({ k, b, h }: P) {
  const [q, setQ] = useState("");
  const pills = String(b.props?.pills ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const [pill, setPill] = useState(pills[0] ?? "");
  return (
    <View className="gap-s3">
      {b.props?.search !== false ? <Field label={String(rows(c(b).fields)[0]?.label ?? "Search")} value={q} onChangeText={(t) => { setQ(t); h.filter?.(k, t, pill); }} /> : null}
      {pills.length ? <FilterPills options={pills.map((x): [string, string] => [x, x])} value={pill} onChange={(v) => { setPill(v); h.filter?.(k, q, v); }} label="Filter" /> : null}
    </View>
  );
}
