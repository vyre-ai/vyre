import { View } from "react-native";
import { Avatar, type AvatarRef } from "../components/Avatar";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Chip } from "../components/Chip";
import { Text } from "../components/Text";
import type { IconName } from "../components/Icon";

/** The top of a record page: who or what it is, the three facts that matter, and the actions a person takes most. Facts come from the type's own list, not from a fixed set. */
export function RecordHeader({ face, title, kind, facts, actions }: { face: AvatarRef; title: string; kind: string; facts: [label: string, value: string][]; actions: { label: string; icon?: IconName; primary?: boolean; onPress: () => void }[] }) {
  return (
    <Card className="gap-s3">
      <View className="flex-row items-center gap-s3">
        <Avatar of={face} />
        <View className="min-w-0 flex-1"><Text size="title" strong>{title}</Text><Text size="caption" tone="label">{kind}</Text></View>
      </View>
      <View className="flex-row flex-wrap gap-s2">{facts.map(([l, v]) => <Chip key={l}>{`${l}: ${v}`}</Chip>)}</View>
      <View className="flex-row flex-wrap gap-s2">{actions.map((a) => <Button key={a.label} kind={a.primary ? "primary" : "secondary"} size="sm" icon={a.icon} label={a.label} onPress={a.onPress} />)}</View>
    </Card>
  );
}
