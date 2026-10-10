// The blocks of the design language, drawn with @vyre/ui. One component per block type; each reads only its own resolved `content` and `props`.
// Spacing comes from tokens through the components; a block never takes a colour or a size from its data.
import { useState } from "react";
import { Image, View } from "react-native";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { ICON_NAMES, type IconName } from "../components/Icon";
import { IconTile } from "../components/IconTile";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import { EmptyState } from "../components/States";
import { Table } from "../components/Table";
import { Text } from "../components/Text";
import { TimelineItem } from "../components/TimelineItem";
import { iconFor } from "./symbols.js";
import { accessoryAsChip, rowExtras } from "./list-rules.js";
import { AvatarStack } from "../components/Avatar";
import { ProviderBadge } from "../components/ProviderBadge";
import { markRef } from "../marks/useMark";
import { IconButton } from "../components/Button";
import { Menu } from "../components/Menu";
import { Sheet } from "../components/Sheet";
import { useUiTheme } from "../theme";
import { TypedTable } from "./TypedTable";
import type { Action, Block, Handlers } from "./types";

type P = { k: string; b: Block; h: Handlers };
const c = (b: Block) => b.content ?? {};
const rows = (x: any): any[] => (Array.isArray(x) ? x : []);
const more = (n?: number) => (n ? <Text size="caption" tone="label">{`${n} more`}</Text> : null);

/** The actions a block carries as a row of buttons: the first is the primary unless the block says otherwise. */
export function ActionBar({ k, actions, primary, h, id }: { k: string; actions?: Action[]; primary?: string; h: Handlers; id?: string }) {
  if (!actions?.length) return null;
  return (
    <View className="flex-row flex-wrap gap-s2">
      {actions.map((a, i) => <Button key={a.id} label={a.title} kind={(primary ? primary === a.id : i === 0) ? "primary" : "secondary"} onPress={() => h.act?.(k, a.id, id)} />)}
    </View>
  );
}

/** A row's actions: the first is a button (44 high on a phone), the rest are in a menu behind the more mark. Nothing else is drawn from them but their words. */
function RowActions({ k, row, actions, h }: { k: string; row: any; actions: { id: string; title: string; kind: "plain" | "primary" | "hold"; confirm?: string }[]; h: Handlers }) {
  const { phone } = useUiTheme();
  const [ask, setAsk] = useState<{ id: string; title: string; confirm?: string } | null>(null);
  if (!actions.length || !h.act) return null;
  // A held press cannot be a menu item, so a hold action is always its own button; the first action is a button; the rest are in the menu.
  const inline = actions.filter((a, i) => i === 0 || a.kind === "hold");
  const rest = actions.filter((a) => !inline.includes(a));
  // An action with a sentence to say first opens a sheet that says it; the action runs only when the person confirms.
  const go = (a: { id: string; title: string; confirm?: string }) => (a.confirm ? setAsk(a) : h.act!(k, a.id, String(row.id)));
  return (
    <>
      {inline.map((a) => <Button key={a.id} size={phone ? "md" : "sm"} kind={a.kind === "primary" ? "primary" : a.kind === "hold" ? "holdText" : "ghost"} label={a.title} onPress={() => go(a)} />)}
      {rest.length ? <Menu trigger={<IconButton icon="more" label={`More for ${row.title}`} touch={phone} />} items={rest.map((a) => ({ label: a.title, onPress: () => go(a) }))} /> : null}
      <Sheet open={!!ask} onClose={() => setAsk(null)} title={ask?.title}>
        <View className="gap-s3">
          <Text>{ask?.confirm ?? ""}</Text>
          <View className="flex-row gap-s2"><Button kind="danger" label={ask?.title ?? "Confirm"} onPress={() => { const a = ask; setAsk(null); if (a) h.act!(k, a.id, String(row.id)); }} /><Button kind="ghost" label="Not now" onPress={() => setAsk(null)} /></View>
        </View>
      </Sheet>
    </>
  );
}

export function ListBlock({ k, b, h }: P) {
  const r = rows(c(b).rows);
  if (!r.length) return <EmptyState title={c(b).empty || b.props?.emptyTitle || "Nothing here."} />;
  // The spec's own fields, all drawn: `icon` is a tile before the title, `group` makes one card per group in the order the groups first appear, and a tight list is the settings density
  // (dense rows, a chevron where a row opens, the accessory as a plain state instead of a chip).
  const tight = b.props?.density === "tight";
  const groups: { name: string; rows: any[] }[] = [];
  for (const x of r) {
    const name = typeof x.group === "string" ? x.group : "";
    let g = groups.find((y) => y.name === name);
    if (!g) groups.push((g = { name, rows: [] }));
    g.rows.push(x);
  }
  const card = (rs: any[]) => (
    <Card flush>
      {rs.map((x, i) => {
        const ex = rowExtras(x);
        return (
          <View key={x.id ?? i} style={ex.dim ? { opacity: 0.5 } : undefined}>
            {i > 0 ? <Divider inset={iconFor(x.icon, ICON_NAMES) ? 60 : 0} /> : null}
            <Row dense={tight} chevron={tight && !!h.open}
              lead={ex.faces.length ? <AvatarStack of={ex.faces.map((f) => ({ ...markRef(f.kind as "person" | "assistant" | "teammate" | "agent" | "device", f.name, f.id), ...(f.device ? { device: f.device as "phone" | "computer" | "server" } : {}) }))} size={40} max={3} /> : iconFor(x.icon, ICON_NAMES) ? <IconTile name={iconFor(x.icon, ICON_NAMES) as IconName} /> : undefined}
              title={x.title} sub={x.subtitle}
              end={ex.any
                ? <>{ex.providers.map((p) => <ProviderBadge key={p} provider={p} size={16} />)}{ex.accessories.map((a, j) => (a.as === "text" ? <Text key={j} size="caption" tone="label">{a.label}</Text> : <Chip key={j} tone={a.tone as any}>{a.label}</Chip>))}<RowActions k={k} row={x} actions={ex.actions} h={h} /></>
                : x.accessory && accessoryAsChip(tight, x.tone) ? <Chip tone={x.tone}>{String(x.accessory)}</Chip> : undefined}
              state={!ex.any && x.accessory && !accessoryAsChip(tight, x.tone) ? String(x.accessory) : undefined}
              onPress={h.open ? () => h.open!(k, x) : undefined} />
          </View>
        );
      })}
    </Card>
  );
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      {groups.length === 1 && !groups[0].name ? card(groups[0].rows) : groups.map((g) => <View key={g.name}>{g.name ? <SectionLabel>{g.name}</SectionLabel> : null}{card(g.rows)}{h.slot?.(k, `after:${g.name}`)}</View>)}
      {more(typeof c(b).more === "number" ? c(b).more : undefined)}
    </View>
  );
}

export function StatsBlock({ b }: P) {
  const items = rows(c(b).items);
  const cols = b.props?.cols ?? Math.min(items.length, 4);
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <View className="flex-row flex-wrap gap-s3">
        {items.map((it, i) => (
          <Card key={`${it.label}${i}`} className="flex-1" style={{ minWidth: cols >= 3 ? 120 : 140 }}>
            <Text size="caption" tone="label" numberOfLines={1}>{it.label}</Text>
            <Text strong size="title">{it.value}</Text>
            {it.delta ? <Text size="caption" tone={String(it.delta).startsWith("-") ? "err" : it.tone === "warn" ? "warn" : "ok"}>{it.delta}</Text> : it.tone === "warn" ? <Text size="caption" tone="warn">Needs a look</Text> : null}
            {Array.isArray(it.spark) && it.spark.length > 1 ? <Spark points={it.spark} /> : null}
          </Card>
        ))}
      </View>
      {more(c(b).more)}
    </View>
  );
}

/** A row of thin bars: the shape of a series, no axis. */
function Spark({ points }: { points: number[] }) {
  const max = Math.max(1, ...points);
  return <View className="mt-s2 flex-row items-end gap-s1" style={{ height: 24 }} accessibilityLabel={`Trend: ${points.join(", ")}`}>{points.map((p, i) => <View key={i} className="flex-1 bg-accent" style={{ borderTopLeftRadius: 3, borderTopRightRadius: 3, height: `${Math.max(8, (p / max) * 100)}%`, opacity: 0.35 + 0.65 * ((i + 1) / points.length) }} />)}</View>;
}

export function ChartBlock({ b }: P) {
  const pts: { label: string; value: number }[] = rows(c(b).points).map((p) => ({ label: String(p.label), value: Number(p.value) }));
  if (!pts.length) return <EmptyState title={c(b).empty || "Nothing to chart yet."} />;
  const max = Math.max(1, ...pts.map((p) => p.value));
  return (
    <Card title={b.props?.title}>
      <View className="flex-row items-end gap-s2" style={{ height: 120 }} accessibilityRole="image" accessibilityLabel={pts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {pts.map((p) => <View key={p.label} className="flex-1 bg-accent" style={{ height: `${Math.max(4, (p.value / max) * 100)}%`, maxWidth: 56, borderTopLeftRadius: 6, borderTopRightRadius: 6 }} />)}
      </View>
      <View className="mt-s2 flex-row gap-s2">{pts.map((p) => <View key={p.label} className="flex-1"><Text size="caption" tone="label" numberOfLines={1} style={{ textAlign: "center" }}>{p.label}</Text></View>)}</View>
    </Card>
  );
}

export function SummaryBlock({ k, b, h }: P) {
  const cards = rows(c(b).cards);
  return (
    <View className="gap-s3">
      {cards.length ? <StatsBlock k={k} h={h} b={{ type: "stats", props: b.props, content: { items: cards.map((x) => ({ label: x.label, value: x.value })) } }} /> : null}
      {c(b).chart ? <ChartBlock k={k} h={h} b={{ type: "chart", content: { points: c(b).chart.points } }} /> : null}
      {!cards.length && !c(b).chart ? <EmptyState title={c(b).empty || "Nothing to count yet."} /> : null}
    </View>
  );
}

export function KeyValueBlock({ b }: P) {
  const pairs = rows(c(b).pairs);
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <Card flush>
        {pairs.map((p, i) => (
          <View key={`${p.label}${i}`}>
            {i > 0 ? <Divider /> : null}
            <Row title={<Text size="secondary" tone="label">{p.label}</Text>} end={<Text numberOfLines={2} style={{ maxWidth: 220, textAlign: "right" }}>{p.value}</Text>} />
          </View>
        ))}
      </Card>
      {more(c(b).more)}
    </View>
  );
}

export function DetailBlock({ k, b, h }: P) {
  const f = rows(c(b).fields);
  return (
    <View className="gap-s3">
      {c(b).body ? <Card><Text>{c(b).body}</Text></Card> : null}
      {f.length ? <KeyValueBlock k={k} h={h} b={{ type: "keyvalue", content: { pairs: f } }} /> : null}
      <ActionBar k={k} actions={b.actions} h={h} id={c(b).id} />
    </View>
  );
}

export function TableBlock({ k, b, h }: P) {
  // Typed content (columns with field kinds, from a type's records) has its own form: the field renderers, sorting and filters of the records list.
  if (b.props?.controls || (Array.isArray(c(b).columns) && c(b).columns.some((x: any) => x && x.kind))) return <TypedTable k={k} b={b} h={h} />;
  const cols = rows(c(b).columns), data = rows(c(b).rows);
  return (
    <View className="gap-s2">
      {b.props?.title ? <SectionLabel>{b.props.title}</SectionLabel> : null}
      <Table
        columns={cols.map((x) => ({ key: String(x.id), label: String(x.title), render: (r: any) => <Text>{String(r.cells?.[x.id] ?? "")}</Text>, sortValue: (r: any) => String(r.cells?.[x.id] ?? "") }))}
        rows={data} rowKey={(r: any) => String(r.id)} onRow={h.open ? (r: any) => h.open!(k, r) : undefined} empty={c(b).empty} />
      {more(c(b).more)}
    </View>
  );
}

export function TimelineBlock({ b }: P) {
  const ev = rows(c(b).events);
  if (!ev.length) return <EmptyState title={c(b).empty || "Nothing has happened yet."} />;
  return (
    <Card title={b.props?.title}>
      {ev.map((e, i) => <TimelineItem key={e.id ?? i} actor={String(e.actor ?? "")} what={String(e.title ?? "")} at={String(e.when ?? "")} why={e.subtitle} />)}
      {more(c(b).more)}
    </Card>
  );
}

export function DocumentBlock({ b }: P) {
  const d = c(b);
  return (
    <Card title={d.title || b.props?.title}>
      {d.kind === "image" && d.url ? <Image source={{ uri: String(d.url) }} accessibilityLabel={String(d.title || "Image")} style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: 8 }} resizeMode="contain" /> : <Text size="read">{String(d.text ?? "")}</Text>}
    </Card>
  );
}

export function TextBlock({ b }: P) {
  const style = b.props?.style ?? "prose", t = String(c(b).text ?? "");
  if (style === "heading") return <Text strong size="title">{t}</Text>;
  if (style === "note") return <Text size="secondary" tone="label">{t}</Text>;
  return <Text>{t}</Text>;
}

export function EmptyBlock({ b }: P) { return <EmptyState title={String(c(b).title ?? "Nothing here")} body={c(b).hint} />; }
export function BannerBlock({ b }: P) { return <Banner tone={b.props?.tone === "err" || b.props?.tone === "warn" ? b.props.tone : "plain"}>{String(c(b).text ?? "")}</Banner>; }
export function ActionsBlock({ k, b, h }: P) { return <ActionBar k={k} actions={b.actions} primary={b.props?.primary} h={h} />; }

export function FormBlock({ k, b, h }: P) {
  const f = c(b), fields = rows(f.fields);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((x) => [x.name, typeof x.default === "string" ? x.default : ""])));
  const missing = fields.filter((x) => x.required && !String(values[x.name] ?? "").trim());
  return (
    <View className="gap-s3">
      {f.title ? <SectionLabel>{String(f.title)}</SectionLabel> : null}
      {fields.map((x) => <Field key={x.name} label={String(x.label)} value={values[x.name] ?? ""} multiline={x.type === "multiline"} kind={x.type === "number" ? "number" : "text"} onChangeText={(t) => setValues((v) => ({ ...v, [x.name]: t }))} />)}
      <View className="flex-row"><Button kind="primary" label={f.submit?.title ?? "Send"} disabled={missing.length > 0} onPress={() => h.submit?.(k, String(f.id ?? ""), values)} /></View>
      {missing.length ? <Text size="caption" tone="label">{`Needed: ${missing.map((x) => x.label).join(", ")}`}</Text> : null}
    </View>
  );
}
