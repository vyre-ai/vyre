import { View } from "react-native";
import { Banner, Button, Text, showToast } from "@vyre/ui";
import { useUpdate } from "../../src/state/update";
import { appliedLine, noticeLines, showNotice } from "../settings/update-model.js";

/** "A new version is out", on Now: what is out, what updating keeps, and the one button (or the command, when this box cannot update itself from here). */
export function UpdateNotice() {
  const { status, busy, apply } = useUpdate();
  if (!status || !showNotice(status)) return null;
  const n = noticeLines(status);
  return (
    <Banner>
      <View className="gap-s2">
        <Text strong>{n.title}</Text>
        <Text>{n.detail}</Text>
        {status.canApply ? (
          <View className="flex-row"><Button size="sm" label={busy ? "Updating" : "Update now"} disabled={busy} onPress={() => { void apply().then((r) => showToast(appliedLine(r))).catch((e) => showToast(e instanceof Error ? e.message : "The update did not start.")); }} /></View>
        ) : null}
      </View>
    </Banner>
  );
}
