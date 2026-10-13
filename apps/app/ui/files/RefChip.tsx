// A reference to something in the Space (a person, agent, record, project, file or tag) drawn as a chip: its icon and its name, never its address. Pressing it opens the thing (`onOpen`).
import { Pressable, View } from "react-native";
import { Icon, type IconName } from "../components/Icon";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { refIcon } from "./ref-model.js";

export function RefChip({ lead, name, kind, onOpen }: { lead: "@" | "#"; name: string; kind: string; onOpen?: () => void }) {
  const { color } = useUiTheme();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10, backgroundColor: color["surface-3"] }}>
      <Icon name={refIcon(lead, kind) as IconName} size={14} tone={lead === "@" ? "accent" : "text-2"} />
      <Text size="read" strong style={{ color: lead === "@" ? color.accent : color.text }}>{name}</Text>
    </View>
  );
  return onOpen ? <Pressable accessibilityRole="link" accessibilityLabel={`Open ${name}`} onPress={onOpen}>{body}</Pressable> : body;
}
