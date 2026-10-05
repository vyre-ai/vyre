import { View } from "react-native";
import { Text } from "../components/Text";
import { Card, Divider } from "../components/Card";
import { Row } from "../components/Row";
import { EmptyState } from "../components/States";
import { fmtMoney } from "../fields/logic.js";
import { ago, barPct, dashboardCards, titleOf, viewDefOf } from "./logic.js";

function Bars({ bars, max }: { bars: [string, number][]; max: number }) {
  return (
    <View className="gap-s2">
      {bars.map(([label, n]) => (
        <View key={label} accessibilityLabel={`${label}, ${n}`} className="flex-row items-center gap-s3">
          <Text size="caption" className="w-24" numberOfLines={1}>{label}</Text>
          <View className="h-s2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
            <View className="h-s2 rounded-full bg-accent" style={{ width: `${barPct(n, max)}%` }} />
          </View>
          <Text size="caption" strong mono className="w-8 text-right">{String(n)}</Text>
        </View>
      ))}
    </View>
  );
}

/** The dashboard: the cards a type's definition names (sum, count by, funnel, recent), drawn from its rows. */
export function DashboardView({ def, rows, onOpen, now }: { def: any; rows: any[]; onOpen?: (rec: any) => void; now?: number }) {
  const vd = viewDefOf(def);
  const cards = dashboardCards(def, rows, vd);
  if (!cards.length) return <EmptyState title="No dashboard for this type" body="Its definition has no widgets." />;
  const t = now ?? Date.now();
  return (
    <View className="gap-s3">
      {cards.map((c, i) => (
        <Card key={i} title={c.title} className="gap-s3 p-s4">
          {c.kind === "sum" ? (
            <View className="gap-s1">
              <Text size="page" strong mono>{c.money ? fmtMoney(c.total) : String(c.total)}</Text>
              <Text size="caption" tone="label">{c.hint}</Text>
            </View>
          ) : null}
          {c.kind === "countBy" ? <Bars bars={c.bars} max={c.max} /> : null}
          {c.kind === "funnel" ? (<><Bars bars={c.bars} max={c.max} /><Text size="caption" tone="label">{c.hint}</Text></>) : null}
          {c.kind === "recent" ? (
            c.rows.length ? c.rows.map((r: any, j: number) => (
              <View key={r.urn}>
                {j > 0 ? <Divider /> : null}
                <Row title={titleOf(def, r, vd)} end={<Text size="caption" tone="label">{ago(r.updated_at, t)}</Text>} onPress={onOpen ? () => onOpen(r) : undefined} />
              </View>
            )) : <Text tone="label">Nothing yet.</Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}
