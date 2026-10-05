import { View } from "react-native";
import { PressableScale } from "../motion/PressableScale";
import { haptic } from "../motion/haptics";
import { Board } from "../components/Board";
import { Card } from "../components/Card";
import { Text } from "../components/Text";
import { EmptyState } from "../components/States";
import type { FieldEnv } from "../fields/types";
import { boardColumns, columnOf, titleOf, viewDefOf, viewRows } from "./logic.js";
import { TitleCell, fieldNode } from "./shared";

/** The board: columns by a choice or stage field (they stack on a phone), a card per row, and a card moves by drag on the web or by its menu elsewhere. */
export function BoardView({ def, rows, env, onOpen, onMove, view }: { def: any; view?: string; rows: any[]; env: FieldEnv; onOpen?: (rec: any) => void; onMove?: (rec: any, to: string) => void }) {
  const vd = viewDefOf(def, undefined, view);
  rows = viewRows(rows, vd.board?.filter);
  const b = boardColumns(def, rows, vd);
  if (!b) return <EmptyState title="No board for this type" body="Its definition has no field to group by." />;
  return (
    <View className="gap-s3">
      <Board
        columns={b.columns}
        items={rows}
        columnOf={(r: any) => columnOf(b.field, r)}
        keyOf={(r: any) => r.urn}
        onMove={onMove ? (r: any, to: string) => { haptic.stage(); onMove(r, to); } : undefined}
        renderCard={(r: any) => (
          <PressableScale depth={0.98} accessibilityRole="button" accessibilityLabel={titleOf(def, r, vd)} onPress={() => onOpen?.(r)}>
            <Card className="gap-s2 p-s3">
              <TitleCell def={def} rec={r} />
              {b.cardFields.map((f: any) => (
                <View key={f.name} className="flex-row flex-wrap items-center gap-s2">
                  <Text size="caption" tone="label">{f.label}</Text>
                  {fieldNode(f, r, env)}
                </View>
              ))}
            </Card>
          </PressableScale>
        )}
      />
    </View>
  );
}
