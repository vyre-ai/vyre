import { Pressable, ScrollView, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { cn } from "../lib/cn";
import { Text } from "../components/Text";
import { Chip } from "../components/Chip";
import { Icon, type IconName } from "../components/Icon";
import { Row } from "../components/Row";
import { PHONE_MAX, useUiTheme } from "../theme";
import { useWindowDimensions } from "react-native";
import { useMemo } from "react";
import { arrange, edgePath, edgeWords, extent, listOrder, metrics, place } from "./layout.js";

export type NodeState = "pending" | "running" | "waiting" | "done" | "failed" | "paused";
/** One step, as the kernel's canvas API hands it over (graph and paintRun): a lane and a row, what it says, and what to flag. */
export type CanvasNode = {
  id: string; kind: string; label: string; lane: number; y: number; state?: NodeState; note?: string; who?: string;
  outward?: boolean; sealed?: boolean; code?: boolean; waits?: boolean;
};
export type CanvasEdge = { from: string; to: string; kind: "next" | "then" | "else" | "each" | "lane" | "join" };

const ICON: Record<string, IconName> = { trigger: "play", find: "search", pick: "search", filter: "search", create: "plus", update: "file", upsert: "file", remove: "minus", decide: "link", repeat: "refresh", wait: "clock", parallel: "board", branch: "list", subflow: "flows", ask: "face", assign: "hand", agent: "chat", call: "send", stage: "todo", classify: "todo", http: "globe", fn: "terminal" };
const STATE: Record<NodeState, { label: string; tone: "plain" | "accent" | "ok" | "err" | "warn" } | null> = {
  pending: null, running: { label: "Running", tone: "accent" }, waiting: { label: "Waiting on you", tone: "accent" }, done: { label: "Done", tone: "ok" }, failed: { label: "Failed", tone: "err" }, paused: { label: "Paused", tone: "warn" },
};
const px = (v: string | number | undefined, fallback: number) => (typeof v === "string" ? parseFloat(v) || fallback : typeof v === "number" ? v : fallback);

function Flags({ n }: { n: CanvasNode }) {
  const st = n.state ? STATE[n.state] : null;
  return (
    <View className="flex-row flex-wrap items-center gap-s1">
      {st ? <Chip tone={st.tone}>{st.label}</Chip> : null}
      {n.outward ? <Chip tone="warn">Sends outside</Chip> : null}
      {n.sealed ? <Chip tone="sealed" icon="shield">Sealed field</Chip> : null}
      {n.code ? <Chip>Code</Chip> : null}
    </View>
  );
}

/**
 * The Flow canvas. On a wide screen the steps are a node graph (lanes for the branches of a decide or a repeat); on a phone they are an ordered list of
 * Rows. Both show the same states, flags and "if yes / otherwise" words, from the same nodes. The graph is drawn with react-native-svg for the edges and
 * base components for the nodes; sizes come from one space token, so a space's density restyles it. It draws no frame: wrap it in a flush Card.
 */
export function FlowCanvas({ nodes, edges, selected, onSelect, mode }: { nodes: CanvasNode[]; edges: CanvasEdge[]; selected?: string; onSelect?: (id: string) => void; mode?: "graph" | "list" }) {
  const { width } = useWindowDimensions();
  const { map, color } = useUiTheme();
  const list = (mode ?? (width < PHONE_MAX ? "list" : "graph")) === "list";
  // A parallel's lanes go side by side and the step after it waits for all of them (layout.js arrange); the phone's list keeps the kernel's order and the same words.
  const laid = useMemo(() => arrange(nodes, edges), [nodes, edges]);
  const into = new Map(laid.edges.map((e) => [e.to, e.kind]));

  if (list) {
    return (
      <View accessibilityRole="list" className="overflow-hidden">
        {listOrder(nodes).map((n, i) => {
          const words = edgeWords(into.get(n.id) ?? "next");
          return (
            <View key={n.id} className={cn(i && "border-t border-edge", n.lane > 0 && "pl-s6")}>
              <Row selected={selected === n.id} onPress={onSelect ? () => onSelect(n.id) : undefined}
                lead={<View className="h-control w-control items-center justify-center rounded-row bg-surface-3"><Icon name={ICON[n.kind] ?? "todo"} size={20} tone={n.state === "done" ? "ok" : n.state === "waiting" || n.state === "running" ? "accent" : n.state === "failed" ? "err" : "text-2"} /></View>}
                title={<View className="gap-s1">{words ? <Text size="caption" tone="label">{words}</Text> : null}<Text strong>{n.kind === "trigger" ? n.label : `${i}. ${n.label}`}</Text>{n.who ? <Text size="caption" tone="label">{n.who}</Text> : null}{n.note ? <Text size="caption" tone="muted">{n.note}</Text> : null}<Flags n={n} /></View>} />
            </View>
          );
        })}
      </View>
    );
  }

  const m = metrics(px(map["--s-12"], 48));
  const placed = place(laid.nodes, m);
  const at = new Map(placed.map((p) => [p.id, p]));
  const box = extent(laid.nodes, m);
  const stroke = parseFloat(String(map["--s-1"])) / 2 || 2;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerClassName="min-w-full justify-center p-s2">
      <View style={{ width: box.width, height: box.height }}>
        <Svg width={box.width} height={box.height} style={{ position: "absolute", left: 0, top: 0 }}>
          {laid.edges.map((e) => {
            const a = at.get(e.from), b = at.get(e.to);
            if (!a || !b) return null;
            const done = nodes.find((n) => n.id === e.to)?.state === "done" || nodes.find((n) => n.id === e.to)?.state === "waiting";
            return <Path key={e.from + e.to + e.kind} d={edgePath(a, b, m)} fill="none" stroke={done ? color.ok : color["edge-strong"]} strokeWidth={stroke} strokeDasharray={e.kind === "join" ? `${stroke * 3} ${stroke * 2}` : undefined} />;
          })}
        </Svg>
        {placed.map((n) => {
          const words = edgeWords(into.get(n.id) ?? "next");
          return (
            <Pressable key={n.id} accessibilityRole="button" accessibilityLabel={n.label} accessibilityState={{ selected: selected === n.id }} onPress={() => onSelect?.(n.id)}
              style={{ position: "absolute", left: n.left, top: n.top, width: m.w, height: m.h }}
              className={cn("flex-row items-start gap-s2 overflow-hidden rounded-card border p-s2", selected === n.id ? "border-accent" : n.state === "failed" ? "border-err" : "border-edge", n.state === "waiting" ? "bg-accent-wash" : "bg-surface-2")}>
              <View className="h-control-sm w-control-sm flex-none items-center justify-center rounded-row bg-surface-3"><Icon name={ICON[n.kind] ?? "todo"} size={16} tone={n.state === "done" ? "ok" : n.state === "waiting" || n.state === "running" ? "accent" : n.state === "failed" ? "err" : "text-2"} /></View>
              <View className="min-w-0 flex-1 gap-s1">
                {words ? <Text size="caption" tone="label">{words}</Text> : null}
                <Text strong size="caption" numberOfLines={2}>{n.label}</Text>
                {n.who ? <Text size="caption" tone="label" numberOfLines={1}>{n.who}</Text> : null}
                <Flags n={n} />
              </View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}
