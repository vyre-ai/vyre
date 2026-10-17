// The mail page: the one place to write an email as the person. What is held waits at the Gate until the person says yes there.
import { useRouter } from "expo-router";
import { Button, Card, Text } from "@vyre/ui";
import { Page } from "../places/Frame";

export default function MailScreen() {
  const router = useRouter();
  return (
    <Page top title="Mail" actions={<Button kind="primary" size="sm" icon="plus" label="Compose" onPress={() => router.push("/u/mail/compose" as never)} />}>
      <Card>
        <Text tone="muted">Write an email as you. It waits in Vyre until you say yes; nothing is sent before then.</Text>
      </Card>
    </Page>
  );
}
