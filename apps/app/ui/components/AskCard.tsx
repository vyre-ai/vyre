import { View } from "react-native";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Text } from "./Text";
import { Button, type ButtonProps } from "./Button";

/**
 * The one inbox card for a Gate approval, a Flow step that needs a person, a pairing request. It is a plain Card; "needs you" is a chip with
 * the words, not a coloured strip. Buttons name the action ("Approve with Face ID").
 */
export function AskCard({ lead, title, why, tags, actions = [], needsYou = true }: {
  lead?: React.ReactNode; title: string; why?: string; tags?: string[]; needsYou?: boolean;
  actions?: (ButtonProps & { label: string })[];
}) {
  return (
    <Card>
      <View className="flex-row items-start gap-s3">
        {lead ? <View className="flex-none">{lead}</View> : null}
        <View className="min-w-0 flex-1 gap-s2">
          {needsYou ? <Chip tone="accent" icon="now">Needs you</Chip> : null}
          <Text strong>{title}</Text>
          {why ? <Text tone="muted">{why}</Text> : null}
          {tags?.length ? <View className="flex-row flex-wrap gap-s2">{tags.map((t) => <Chip key={t}>{t}</Chip>)}</View> : null}
          {actions.length ? <View className="flex-row flex-wrap gap-s2 pt-s1">{actions.map((a) => <Button key={a.label} size="sm" {...a} />)}</View> : null}
        </View>
      </View>
    </Card>
  );
}
