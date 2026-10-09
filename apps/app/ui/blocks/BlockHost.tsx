// BlockScreen: draws one resolved screen (lib/views/blocks.js) with the block components. The one renderer for module screens and, as they move over, Vyre's own: the host
// gives it a screen and handlers and never looks inside. Layout words are semantic; this file decides the pixels, and a surface that is narrow falls back to a stack.
import { useState } from "react";
import { View } from "react-native";
import { Segmented } from "../components/Segmented";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { Board } from "../components/Board";
import { Card } from "../components/Card";
import { EmptyState } from "../components/States";
import { ActionsBlock, BannerBlock, ChartBlock, DetailBlock, DocumentBlock, EmptyBlock, FormBlock, KeyValueBlock, ListBlock, StatsBlock, SummaryBlock, TableBlock, TextBlock, TimelineBlock, ActionBar } from "./BlockViews";
import type { Block, Handlers, Node, Screen } from "./types";

/** data-* attributes on the web, so a picture test and a scoped custom style can find a block; the native views ignore them. */
const ds = (o: Record<string, string>) => ({ dataSet: o }) as object;

const GAP: Record<string, string> = { s1: "gap-s1", s2: "gap-s2", s3: "gap-s3", s4: "gap-s4", s5: "gap-s5", s6: "gap-s6" };

function BoardBlock({ k, b, h }: { k: string; b: Block; h: Handlers }) {
  const cols = (b.content?.columns ?? []) as any[];
  const items = cols.flatMap((x) => (x.rows ?? []).map((r: any) => ({ ...r, column: x.id })));
  if (!items.length) return <EmptyState title={b.content?.empty || "Nothing here."} />;
  return (
    <Board columns={cols.map((x) => ({ id: x.id, title: x.title }))} items={items} columnOf={(r: any) => r.column} keyOf={(r: any) => r.id}
      onMove={(r: any, to: string) => h.move?.(k, r, to)}
      renderCard={(r: any) => <Card><Text strong>{r.title}</Text>{r.subtitle ? <Text tone="muted" size="caption">{r.subtitle}</Text> : null}</Card>} />
  );
}

/** The block types this renderer draws. A type not here shows one quiet line, so a gap is visible in the gallery and never a crash. */
const DRAW: Record<string, (p: { k: string; b: Block; h: Handlers }) => React.ReactNode> = {
  list: (p) => <ListBlock {...p} />, board: (p) => <BoardBlock {...p} />, summary: (p) => <SummaryBlock {...p} />, detail: (p) => <DetailBlock {...p} />, form: (p) => <FormBlock {...p} />,
  stats: (p) => <StatsBlock {...p} />, keyvalue: (p) => <KeyValueBlock {...p} />, table: (p) => <TableBlock {...p} />, timeline: (p) => <TimelineBlock {...p} />, chart: (p) => <ChartBlock {...p} />,
  document: (p) => <DocumentBlock {...p} />, text: (p) => <TextBlock {...p} />, empty: (p) => <EmptyBlock {...p} />, banner: (p) => <BannerBlock {...p} />, actions: (p) => <ActionsBlock {...p} />,
};
export const DRAWN_TYPES = Object.keys(DRAW);

function Leaf({ k, screen, h }: { k: string; screen: Screen; h: Handlers }) {
  const b = screen.blocks[k];
  if (!b) return null;
  const draw = DRAW[b.type];
  return (
    <View testID={`block-${k}`} {...ds({ block: k })} className="min-w-0">
      {draw ? draw({ k, b, h }) : <Text size="caption" tone="label">{`${b.type} is not drawn here yet.`}</Text>}
      {b.type !== "actions" && b.type !== "list" && b.type !== "board" && b.type !== "detail" && b.actions?.length ? <View className="mt-s3"><ActionBar k={k} actions={b.actions} h={h} /></View> : null}
    </View>
  );
}

function kindOf(n: Node) { return (["block", "col", "row", "grid", "split", "tabs", "stack"] as const).find((x) => n[x] !== undefined); }

function Tree({ n, screen, h, wide, depth = 0 }: { n: Node; screen: Screen; h: Handlers; wide: boolean; depth?: number }) {
  const kind = kindOf(n);
  const gap = GAP[n.gap ?? "s4"] ?? "gap-s4";
  const weight = n.weight ? { flex: n.weight } : null;
  const wrap = (child: React.ReactNode) => (weight ? <View style={weight} className="min-w-0">{child}</View> : child);
  if (kind === "block") return wrap(<Leaf k={n.block!} screen={screen} h={h} />);
  const kids = (n[kind as "col"] ?? []) as Node[];
  const draw = (x: Node, i: number) => <Tree key={i} n={x} screen={screen} h={h} wide={wide} depth={depth + 1} />;
  if (kind === "col") return wrap(<View className={gap}>{kids.map(draw)}</View>);
  if (kind === "row" || kind === "split") {
    if (!wide) return wrap(<View className={gap}>{kids.map(draw)}</View>);
    return wrap(<View className={`flex-row items-start ${gap}`}>{kids.map((x, i) => <View key={i} style={{ flex: x.weight ?? (kind === "split" && i === 0 ? 2 : 1) }} className="min-w-0"><Tree n={{ ...x, weight: undefined }} screen={screen} h={h} wide={wide} depth={depth + 1} /></View>)}</View>);
  }
  if (kind === "grid") return wrap(<View className={`flex-row flex-wrap ${gap}`}>{kids.map((x, i) => <View key={i} style={{ flexGrow: 1, flexBasis: wide ? "30%" : "100%" }} className="min-w-0"><Tree n={x} screen={screen} h={h} wide={wide} depth={depth + 1} /></View>)}</View>);
  if (kind === "tabs") return wrap(<Tabs kids={kids} screen={screen} h={h} wide={wide} gap={gap} />);
  if (kind === "stack") return wrap(<Stack kids={kids} screen={screen} h={h} wide={wide} gap={gap} />);
  return null;
}

function Tabs({ kids, screen, h, wide, gap }: { kids: Node[]; screen: Screen; h: Handlers; wide: boolean; gap: string }) {
  const [i, setI] = useState("0");
  const idx = Math.min(Number(i), kids.length - 1);
  return (
    <View className={gap}>
      <Segmented options={kids.map((x, j): [string, string] => [String(j), x.label ?? `Tab ${j + 1}`])} value={String(idx)} onChange={setI} label="Sections" />
      <Tree n={{ ...kids[idx], label: undefined }} screen={screen} h={h} wide={wide} />
    </View>
  );
}

/** Push navigation: the first child, and the next one when a row in it is opened. */
function Stack({ kids, screen, h, wide, gap }: { kids: Node[]; screen: Screen; h: Handlers; wide: boolean; gap: string }) {
  const [at, setAt] = useState(0);
  const handlers: Handlers = { ...h, open: (b, r) => { if (at < kids.length - 1) setAt(at + 1); h.open?.(b, r); } };
  return (
    <View className={gap}>
      {at > 0 ? <View className="flex-row"><Button label="Back" onPress={() => setAt(at - 1)} /></View> : null}
      <Tree n={kids[at]} screen={screen} h={handlers} wide={wide} />
    </View>
  );
}

export function BlockScreen({ screen, handlers = {}, wide }: { screen: Screen; handlers?: Handlers; wide?: boolean }) {
  const { phone } = useUiTheme();
  return <View {...ds({ screen: screen.id ?? "screen" })} className="min-w-0"><Tree n={screen.layout} screen={screen} h={handlers} wide={wide ?? !phone} /></View>;
}
