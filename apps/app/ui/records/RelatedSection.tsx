import { View } from "react-native";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Row } from "../components/Row";
import { Text } from "../components/Text";
import { markRef } from "../marks/useMark";

export type RelatedRow = { id: string; title: string; sub?: string; chip?: string };

/** The records that link to this one, by type ("Assets 3"), each a row that opens, with Add under it. A type with none says so and offers the same Add. */
export function RelatedSection({ title, noun, rows, onOpen, onAdd }: { title: string; noun: string; rows: RelatedRow[]; onOpen: (id: string) => void; /** Omitted, there is no Add under the list. */ onAdd?: () => void }) {
  return (
    <Card title={title} flush actions={<Text size="caption" tone="label">{String(rows.length)}</Text>}>
      {rows.length ? rows.map((r, i) => (
        <View key={r.id}>
          {i ? <Divider /> : null}
          <Row lead={<Avatar of={markRef("project", r.title, r.id)} />} title={r.title} sub={r.sub} chevron onPress={() => onOpen(r.id)} end={r.chip ? <Chip>{r.chip}</Chip> : undefined} />
        </View>
      )) : <View className="px-s4 pb-s3"><Text tone="label">{`No ${title.toLowerCase()} yet.`}</Text></View>}
      {onAdd ? <View className="flex-row px-s2 pb-s2"><Button kind="ghost" size="sm" icon="plus" label={`Add ${noun}`} onPress={onAdd} /></View> : null}
    </Card>
  );
}
