import { View } from "react-native";
import { Avatar } from "../components/Avatar";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { markRef } from "../marks/useMark";

export type MapType = { name: string; label: string; plural: string; fields: number; records: number; kit?: string; links: { to: string; label: string; many: boolean }[] };

/** The firm's data model on one screen: every type with its field and record counts and the types it links to, so "Assets belong to Clients" can be seen, not remembered. */
export function ModelMap({ types, onOpen }: { types: MapType[]; onOpen: (name: string) => void }) {
  const label = (n: string) => types.find((t) => t.name === n)?.plural ?? n;
  return (
    <Card flush>
      {types.map((t, i) => (
        <View key={t.name}>
          {i ? <Divider /> : null}
          <Row lead={<Avatar of={markRef("project", t.plural, t.name)} />} title={t.plural} sub={`${t.fields} fields, ${t.records} ${t.records === 1 ? t.label.toLowerCase() : t.plural.toLowerCase()}`} chevron onPress={() => onOpen(t.name)}
            end={t.kit ? <Chip>Kit</Chip> : undefined} />
          {t.links.length ? (
            <View className="flex-row flex-wrap items-center gap-s2 pb-s3 pl-s12 pr-s4">
              <Text size="caption" tone="label">Links to</Text>
              {t.links.map((l) => <Chip key={l.label} icon="link">{`${l.many ? "many " : ""}${label(l.to)}`}</Chip>)}
            </View>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
