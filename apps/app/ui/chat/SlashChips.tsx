import { View } from "react-native";
import { Chip, Text } from "../index";
import { FEATURED_SLASHES, type FeaturedSlash } from "./slash";

export function SlashChips({ commands = FEATURED_SLASHES, title = "Slash commands" }: { commands?: readonly FeaturedSlash[]; title?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text strong>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {commands.map((c) => <Chip key={c} tone="plain">{`/${c}`}</Chip>)}
      </View>
    </View>
  );
}
