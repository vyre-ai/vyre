// The work email the firm Google key may act as for one member (google.members.email). Only the Space owner sets it: the box checks, so this shows only to the owner. Clearing it takes the member's mail, calendar and Drive away.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Field, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";

export default function WorkEmail({ person }: { person: string }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const load = useCallback(() => {
    tool<{ person: string; email: string }[]>("google.members.email", {}).then((rows) => { const r = (rows || []).find((x) => x.person === person); setSaved(r ? r.email : null); setText(r ? r.email : ""); }).catch(() => setSaved(undefined));
  }, [person]);
  useEffect(load, [load]);
  if (saved === undefined) return null;
  const fail = (e: unknown) => showToast((e as { message?: string })?.message || "That did not work.");
  return (
    <View className="gap-s2">
      <Text strong>Work email</Text>
      <Text size="secondary" tone="muted">The address the firm Google key acts as for them: their own mail, calendar and Drive. Only you can set it.</Text>
      <Field label="Work email" value={text} onChangeText={setText} placeholder="name@yourfirm.com" />
      <View className="flex-row gap-s2">
        <Button kind="primary" size="sm" label="Save email" disabled={!text.trim() || text.trim().toLowerCase() === saved} onPress={() => { tool("google.members.email", { person, email: text.trim() }).then(load).catch(fail); }} />
        {saved ? <Button kind="ghost" size="sm" label="Clear" onPress={() => { tool("google.members.email", { person }).then(load).catch(fail); }} /> : null}
      </View>
    </View>
  );
}
