import { useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { WINDOW, windowOf } from "./windowing.js";
import { PressableScale } from "../motion/PressableScale";
import { Avatar } from "../components/Avatar";
import { Card } from "../components/Card";
import { Text } from "../components/Text";
import { EmptyState } from "../components/States";
import { galleryCards, viewDefOf, viewRows } from "./logic.js";

/** The gallery: a card per record with a face or a logo, its title and one line under it. For a type that is about who or what it is (a company), not about its fields. */
export function GalleryView({ def, rows, onOpen, view, noFilter }: { def: any; view?: string; noFilter?: boolean; rows: any[]; onOpen?: (rec: any) => void }) {
  const vd = viewDefOf(def, undefined, view);
  const cards = galleryCards(def, viewRows(rows, noFilter ? undefined : vd.gallery?.filter), vd);
  const [limit, setLimit] = useState(WINDOW);
  const win = windowOf(cards, limit);
  if (!vd.gallery) return <EmptyState title="No gallery for this type" body="Its definition has no title to show on a card." />;
  if (!cards.length) return <EmptyState title="Nothing here yet" body="Records appear here as cards." />;
  return (
    <View className="gap-s3">
    <View className="flex-row flex-wrap gap-s3">
      {win.rows.map((c: any) => (
        <PressableScale key={c.key} depth={0.98} accessibilityRole="button" accessibilityLabel={c.title} onPress={() => onOpen?.(c.rec)} style={{ width: 168 }}>
          <Card className="items-center gap-s2 p-s4">
            {c.image ? <Avatar of={{ kind: "service", id: c.key, name: c.title, image: c.image } as any} size={44} /> : <Avatar of={{ kind: "person", id: c.key, name: c.title }} size={44} />}
            <Text strong numberOfLines={1} className="text-center">{c.title}</Text>
            {c.subtitle ? <Text size="caption" tone="label" numberOfLines={1} className="text-center">{c.subtitle}</Text> : null}
          </Card>
        </PressableScale>
      ))}
    </View>
    {win.more ? <Button kind="ghost" size="sm" label={win.label} onPress={() => setLimit(limit + WINDOW)} /> : null}
    </View>
  );
}
