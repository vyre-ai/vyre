import { View } from "react-native";
import { Card, Divider } from "../components/Card";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";

export type Starter = { id: string; label: string; blurb: string; fields: string[]; from?: string };

/** Add a type: pick a starting point (blank or from a Kit) and see the fields it brings before anything is made, then name it. */
export function TypeStarter({ starters, picked, onPick, name, onName, work, onWork }: { starters: Starter[]; picked: string; onPick: (id: string) => void; name: string; onName: (n: string) => void; work: boolean; onWork: (w: boolean) => void }) {
  const s = starters.find((x) => x.id === picked) ?? starters[0];
  return (
    <View className="gap-s3">
      <Card flush>
        {starters.map((x, i) => (
          <View key={x.id}>
            {i ? <Divider /> : null}
            <Row title={x.label} sub={x.blurb} selected={x.id === picked} onPress={() => onPick(x.id)} end={x.from ? <Chip>Kit</Chip> : undefined} />
          </View>
        ))}
      </Card>
      <View className="gap-s1">
        <Text size="caption" strong tone="label">{`It starts with ${s.fields.length} ${s.fields.length === 1 ? "field" : "fields"}`}</Text>
        <View className="flex-row flex-wrap gap-s2">{s.fields.map((f) => <Chip key={f}>{f}</Chip>)}</View>
        <Text size="caption" tone="label">You can change every one of them after.</Text>
      </View>
      <Field label="Name (one of them)" value={name} onChangeText={onName} />
      <Card><Row title="Holds work" sub="Tasks, stages, members and chats on every one." end={<Switch label="Holds work" on={work} onChange={onWork} />} /></Card>
    </View>
  );
}
