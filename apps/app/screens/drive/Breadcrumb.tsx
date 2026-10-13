// The one breadcrumb of every Files pane: the steps as plain links with a faint slash between, and the step you are in as plain text. Not a row of buttons.
import { Pressable, View } from "react-native";
import { Text } from "@vyre/ui";

export function Breadcrumb({ crumbs, onPress, end }: { crumbs: { name: string; key: string }[]; onPress: (key: string) => void; end?: React.ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center gap-x-s2 gap-y-s1">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <View key={c.key + i} className="flex-row items-center gap-s2">
            {i ? <Text tone="faint">/</Text> : null}
            {last ? <Text strong>{c.name}</Text> : <Pressable accessibilityRole="link" onPress={() => onPress(c.key)}><Text tone="label">{c.name}</Text></Pressable>}
          </View>
        );
      })}
      {end ? <View className="ml-auto">{end}</View> : null}
    </View>
  );
}
