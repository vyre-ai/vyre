import { View } from "react-native";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Row } from "../components/Row";
import { SectionLabel } from "../components/SectionLabel";
import { Text } from "../components/Text";
import { markRef } from "../marks/useMark";

export type RelatedRow = { id: string; title: string; sub?: string; chip?: string };

/** The records that link to this one, by type ("Assets 3"), each a row that opens, with Add under it. A type with none says so and offers the same Add. */
export function RelatedSection({ title, noun, rows, onOpen, onAdd }: { title: string; noun: string; rows: RelatedRow[]; onOpen: (id: string) => void; onAdd: () => void }) {
  return (
    <View className="gap-s2">
      <SectionLabel meta={String(rows.length)} first>{title}</SectionLabel>
      {rows.length ? (
        <Card flush>
          {rows.map((r, i) => (
            <View key={r.id}>
              {i ? <Divider /> : null}
              <Row lead={<Avatar of={markRef("project", r.title, r.id)} />} title={r.title} sub={r.sub} chevron onPress={() => onOpen(r.id)} end={r.chip ? <Chip>{r.chip}</Chip> : undefined} />
            </View>
          ))}
        </Card>
      ) : <Text tone="label">{`No ${title.toLowerCase()} yet.`}</Text>}
      <View className="flex-row"><Button kind="ghost" size="sm" icon="plus" label={`Add ${noun}`} onPress={onAdd} /></View>
    </View>
  );
}
