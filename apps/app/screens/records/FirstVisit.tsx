import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Field, Text, showToast } from "@vyre/ui";
import { openEngineer } from "../engineer/openEngineer";
import { kvGet, kvSet } from "../../src/state/kv";
import { isMissing, recordsApi } from "./records-api";

const KEY = "vyre.records.firstVisit.done";

/**
 * The first visit: "What does your team do?" in one sentence. "Set it up" hands the sentence to the Engineer, who proposes the types, roles, stages and views to accept or change; "Try with sample data" fills the Space with
 * made-up records that come out again in one click (the banner below it while they are there). Not now puts it away for good on this device.
 */
export function FirstVisit({ show, samples, reload }: { show: boolean; samples: number; reload: () => void }) {
  const router = useRouter();
  const [away, setAway] = useState(true);
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void kvGet(KEY).then((v) => setAway(v === "1")); }, []);
  const toggleSample = async (on: boolean) => {
    setBusy(true);
    const r = on ? await recordsApi.sampleAdd() : await recordsApi.sampleRemove();
    setBusy(false);
    if (r.error) { showToast(isMissing(r.error) ? "Sample data is not available on this box yet." : r.error.message || "That did not work."); return; }
    showToast(on ? "Sample data is on." : "Sample data removed.");
    reload();
  };
  if (samples > 0) {
    return (
      <Banner>
        <Text strong>Sample data is on.</Text>
        <Text size="caption" tone="muted">Everything made up is marked, and none of it is real.</Text>
        <View className="flex-row"><Button kind="secondary" size="sm" label="Remove sample data" loading={busy} disabled={busy} onPress={() => void toggleSample(false)} /></View>
      </Banner>
    );
  }
  if (!show || away) return null;
  return (
    <Card className="gap-s3">
      <Text size="page" strong>What does your team do?</Text>
      <Text tone="muted">One sentence is enough. The Engineer sets up the types, roles, stages and views to match, and you can change any of it later.</Text>
      <Field name="What does your team do?" value={what} onChangeText={setWhat} placeholder="We design brands and websites for small hotels" onSubmit={() => what.trim() && openEngineer(router, { source: "object", intent: "create", words: what.trim() })} />
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="primary" label="Set it up" disabled={!what.trim()} onPress={() => openEngineer(router, { source: "object", intent: "create", words: what.trim() })} />
        <Button kind="secondary" label="Try with sample data" loading={busy} disabled={busy} onPress={() => void toggleSample(true)} />
        <Button kind="ghost" label="Not now" onPress={() => { setAway(true); void kvSet(KEY, "1"); }} />
      </View>
      <Text size="caption" tone="label">Sample data fills the Space with made-up people, deals and tasks. Remove them in one click.</Text>
    </Card>
  );
}
