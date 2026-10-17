import { ChoiceList, type Choice } from "./ChoiceList";
import { Text } from "./Text";
import { View } from "react-native";

/**
 * The first choice on a guided flow: two ways forward, each a card from ChoiceList, with a title and one line.
 * Join a space or create a space. The screen keeps the choice.
 */
export function ChoiceHero<T extends string>({ title, lead, options, value, onChange }: {
  title: string; lead?: string; options: Choice<T>[]; value?: T; onChange: (v: T) => void;
}) {
  return (
    <View className="gap-s4">
      <View className="gap-s2">
        <Text size="title" strong accessibilityRole="header">{title}</Text>
        {lead ? <Text tone="muted">{lead}</Text> : null}
      </View>
      <ChoiceList label={title} options={options} value={value} onChange={onChange} />
    </View>
  );
}
