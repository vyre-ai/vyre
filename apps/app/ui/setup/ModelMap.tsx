import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { IconTile } from "../components/IconTile";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import type { IconName } from "../components/Icon";
import { iconOfType, splitTypes, subLine } from "./model-map.js";

export type MapType = { name: string; label: string; plural: string; fields: number; records: number; kit?: string; links: { to: string; label: string; many: boolean }[] };

/**
 * The firm's data model on one screen: each object with an icon of its own, its field and record counts and the objects it links to on one line. A person's own objects come first; the ones the product
 * ships (Templates, Playbooks, Team members, Projects) sit under "Built in".
 */
export function ModelMap({ types, onOpen }: { types: MapType[]; onOpen: (name: string) => void }) {
  const label = (n: string) => types.find((t) => t.name === n)?.plural ?? n;
  const { own, builtIn } = splitTypes(types);
  const list = (items: MapType[]) => (
    <Card flush>
      {items.map((t, i) => (
        <View key={t.name}>
          {i ? <Divider /> : null}
          <Row lead={<View className="pr-s3"><IconTile name={iconOfType(t.name) as IconName} /></View>} title={t.plural} sub={subLine(t, label)} chevron onPress={() => onOpen(t.name)}
            end={t.kit ? <Chip>Kit</Chip> : undefined} />
        </View>
      ))}
    </Card>
  );
  return (
    <View className="gap-s3">
      {own.length ? list(own) : null}
      {builtIn.length ? <><SectionLabel>Built in</SectionLabel>{list(builtIn)}</> : null}
    </View>
  );
}
