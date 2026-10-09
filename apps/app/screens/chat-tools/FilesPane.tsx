// The chat's files as a pane beside the chat on a wide window: it stays open while you keep working in the chat. A phone gets the same list as a page of the chat tools sheet.
import { View } from "react-native";
import { Button, Divider, SectionLabel, Text } from "@vyre/ui";
import { ChatFiles } from "./ChatFiles";

export function FilesPane({ chat, onClose }: { chat: string; onClose: () => void }) {
  return (
    <View accessibilityLabel="Files in this chat" style={{ width: 440, flexShrink: 0, borderLeftWidth: 1, borderLeftColor: "rgba(127,127,127,0.25)" }} className="min-h-0">
      <View className="flex-row items-center justify-between px-s4 pt-s3 pb-s2">
        <Text strong>Files</Text>
        <Button kind="ghost" size="sm" label="Close" onPress={onClose} />
      </View>
      <Divider />
      <View className="min-h-0 flex-1 overflow-scroll px-s4 pt-s2 pb-s4"><ChatFiles chat={chat} /></View>
    </View>
  );
}
