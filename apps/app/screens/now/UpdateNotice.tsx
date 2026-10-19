import { View } from "react-native";
import { Banner, Button, Text, showToast } from "@vyre/ui";
import { useUpdate } from "../../src/state/update";
import { appliedLine, askLine, noticeLines, showNotice } from "../settings/update-model.js";
import { isBoxless, shell } from "../../src/shell/shell";
import { AppUpdateCard } from "./AppUpdateCard";

/** "A new version is out", on Now: the Mac app's own update when this is the Mac app (AppUpdateCard), and the server's. */
export function UpdateNotice() {
  const u = useUpdate();
  return (
    <>
      {shell() ? <AppUpdateCard hint={u.status?.available ?? null} /> : null}
      <ServerUpdateNotice u={u} />
    </>
  );
}

/** The server's card: what is out, what updating keeps, and the one button (or the command, when this box cannot update itself from here). Every press shows what happens: asking, "Updating", then a toast. */
function ServerUpdateNotice({ u }: { u: ReturnType<typeof useUpdate> }) {
  const { status, busy, asking, ask, cancel, apply } = u;
  if (!status || !showNotice(status)) return null;
  const n = noticeLines(status, { server: isBoxless() });
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
