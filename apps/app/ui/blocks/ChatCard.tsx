// A screen as a card in a chat thread: the glance form of the same description the app draws in full (views.get with surface "chat"). One quiet card, the screen's own title, an Open
// button that goes to the full screen. Approvals inside it keep their exact words (they never shrink).
import { View } from "react-native";
import { Button } from "../components/Button";
import { Text } from "../components/Text";
import { BlockScreen } from "./BlockHost";
import type { Handlers, Screen } from "./types";

export function ChatCard({ screen, onOpen, handlers }: { screen: Screen; onOpen?: () => void; handlers?: Handlers }) {
  return (
    <View className="gap-s3" style={{ width: "100%", maxWidth: 560 }} accessibilityLabel={screen.title ? `${screen.title}, from this chat` : undefined}>
      {screen.title ? <Text strong size="headline">{screen.title}</Text> : null}
      <BlockScreen screen={screen} handlers={handlers} wide={false} />
      {onOpen ? <View className="flex-row"><Button label="Open" onPress={onOpen} /></View> : null}
    </View>
  );
}
