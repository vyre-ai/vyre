import { Button, Card, Sheet, Text } from "@vyre/ui";
import { View } from "react-native";
import { useApproval } from "../../src/real/approval-state";
import { APPROVE_ON_PHONE, WAITING_LINE } from "../../src/real/approvals.js";

/** Shown while a kernel act waits for the person's phone. Stopping the wait changes nothing on the box. */
export function ApprovalSheet() {
  const { open, cancel, line } = useApproval();
  return (
    <Sheet open={open} onClose={cancel} title={APPROVE_ON_PHONE}>
      <View className="gap-s3">
        {line ? <Text strong>{line}</Text> : null}
        <Text>{WAITING_LINE}</Text>
        <Card><Text size="caption" tone="label">Waiting for your phone. This ends by itself after five minutes.</Text></Card>
        <View className="self-start"><Button kind="ghost" label="Stop waiting" onPress={cancel} /></View>
      </View>
    </Sheet>
  );
}
