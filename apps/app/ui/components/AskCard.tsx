import { Pressable, View } from "react-native";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Text } from "./Text";
import { Button, type ButtonProps } from "./Button";

type Tag = string | { text: string; tone?: "plain" | "accent" | "ok" | "warn" | "err" | "sealed" | "space" };

/**
 * The one inbox card for a Gate approval, a Flow step that needs a person, a pairing request, a task. It is a plain Card; "needs you" is a chip with
 * the words, not a coloured strip. Buttons name the action ("Approve with Face ID"). `onTitlePress` makes the title open the thing; `children` sit
 * above the buttons (an inline field); a tag may carry a tone ("Stuck" is warm).
 */
export function AskCard({ lead, title, why, tags, actions = [], needsYou = true, onTitlePress, children }: {
  lead?: React.ReactNode; title: string; why?: string; tags?: Tag[]; needsYou?: boolean; onTitlePress?: () => void; children?: React.ReactNode;
  actions?: (ButtonProps & { label: string })[];
}) {
  const t = <Text strong>{title}</Text>;
  return (
    <Card>
      <View className="flex-row items-start gap-s3">
        {lead ? <View className="flex-none">{lead}</View> : null}
        <View className="min-w-0 flex-1 gap-s2">
          {needsYou ? <Chip tone="accent" icon="now">Needs you</Chip> : null}
          {onTitlePress ? <Pressable accessibilityRole="button" onPress={onTitlePress}>{t}</Pressable> : t}
          {why ? <Text tone="muted">{why}</Text> : null}
          {tags?.length ? <View className="flex-row flex-wrap gap-s2">{tags.map((g) => { const x = typeof g === "string" ? { text: g } : g; return <Chip key={x.text} tone={x.tone}>{x.text}</Chip>; })}</View> : null}
          {children}
          {actions.length ? <View className="flex-row flex-wrap gap-s2 pt-s1">{actions.map((a) => <Button key={a.label} size="sm" {...a} />)}</View> : null}
        </View>
      </View>
    </Card>
  );
}
