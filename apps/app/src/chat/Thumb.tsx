// A picture added to a message, shown as the picture: a small square with its own corners, dimmed while it uploads, with a small cross to take it back. In the transcript the same square is larger and has no cross.
import { Image, Pressable, View } from "react-native";
import { Icon, Text, useUiTheme } from "@vyre/ui";

export function Thumb({ uri, name, size = 56, state = "ready", onRemove }: { uri: string; name: string; size?: number; state?: "uploading" | "ready" | "failed"; onRemove?: () => void }) {
  const { color } = useUiTheme();
  return (
    <View accessible accessibilityLabel={state === "failed" ? `${name}, not added` : name} style={{ width: size, height: size, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: state === "failed" ? color.err : color.edge, backgroundColor: color["surface-3"] }}>
      <Image accessibilityIgnoresInvertColors source={{ uri }} resizeMode="cover" style={{ width: "100%", height: "100%", opacity: state === "ready" ? 1 : 0.45 }} />
      {state === "uploading" ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 4, alignItems: "center" }}><Text size="caption" tone="label">Adding</Text></View> : null}
      {state === "failed" ? <View style={{ position: "absolute", left: 0, right: 0, bottom: 4, alignItems: "center" }}><Text size="caption" tone="err">Not added</Text></View> : null}
      {onRemove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${name}`} onPress={onRemove} hitSlop={12} style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: color.scrim ?? "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" }}>
          <Icon name="x" size={14} tone="inverse" />
        </Pressable>
      ) : null}
    </View>
  );
}
