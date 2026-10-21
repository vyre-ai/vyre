import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Field, Sheet, showToast } from "@vyre/ui";
import { recordsApi } from "./records-api";
import { QUICK } from "./history-model.js";
import { plainError } from "../../src/real/error-note.js";

/** The actions under a record's name: Call, Meeting, Note, Task. The sheet keeps the longer title (Log a call, and the rest). A logged one lands in History; `onLogged` tells the page to read it again. */
export function QuickActions({ urn, onLogged, email }: { urn: string; onLogged: () => void; /** The record's address, when it has one: Send email opens the compose page with it filled in (the email is held for the person's yes, nothing leaves from here). */ email?: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState<null | (typeof QUICK)[number]>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!asking) return;
    setBusy(true);
    const r = await recordsApi.log(urn, asking.key, text.trim());
    setBusy(false);
    if (r.error) { showToast(plainError(r.error, "That did not save.")); return; }
    setAsking(null); setText(""); onLogged();
  };
  return (
    <>
      <View className="flex-row flex-wrap gap-s2">
        {QUICK.map((q) => <Button key={q.key} kind="secondary" size="sm" icon={q.icon} label={q.label} onPress={() => { setText(""); setAsking(q); }} />)}
        {email ? <Button kind="secondary" size="sm" icon="mail" label="Send email" onPress={() => router.push(`/u/mail/compose?to=${encodeURIComponent(email)}` as never)} /> : null}
        <Button kind="secondary" size="sm" icon="task" label="Task" onPress={() => router.push(`/u/record/new?type=task&about=${encodeURIComponent(urn)}` as never)} />
      </View>
      <Sheet open={!!asking} onClose={() => setAsking(null)} title={asking?.sheet}>
        <View className="gap-s3">
          <Field label={asking?.ask} value={text} onChangeText={setText} multiline lines={3} />
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Save" loading={busy} disabled={busy || !text.trim()} onPress={() => void save()} />
            <Button kind="ghost" label="Cancel" onPress={() => setAsking(null)} />
          </View>
        </View>
      </Sheet>
    </>
  );
}
