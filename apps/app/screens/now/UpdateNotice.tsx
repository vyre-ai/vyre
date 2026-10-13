import { View } from "react-native";
import { Banner, Button, Text, showToast } from "@vyre/ui";
import { useUpdate } from "../../src/state/update";
import { appliedLine, askLine, noticeLines, showNotice } from "../settings/update-model.js";

/** "A new version is out", on Now: what is out, what updating keeps, and the one button (or the command, when this box cannot update itself from here). */
export function UpdateNotice() {
  const { status, busy, asking, ask, cancel, apply } = useUpdate();
  if (!status || !showNotice(status)) return null;
  const n = noticeLines(status);
  return (
    <Banner>
      <View className="gap-s2">
        <Text strong>{n.title}</Text>
        <Text>{n.detail}</Text>
        {status.canApply && asking ? (
          <>
            <Text>{askLine(status)}</Text>
            <View className="flex-row gap-s2">
              <Button size="sm" label={busy ? "Updating" : "Yes, update"} disabled={busy} onPress={() => { void apply().then((r) => showToast(appliedLine(r))).catch((e) => showToast(e instanceof Error ? e.message : "The update did not start.")); }} />
              <Button size="sm" label="Not now" disabled={busy} onPress={cancel} />
            </View>
          </>
        ) : status.canApply ? (
          <View className="flex-row"><Button size="sm" label="Update" disabled={busy} onPress={ask} /></View>
        ) : null}
      </View>
    </Banner>
  );
}
