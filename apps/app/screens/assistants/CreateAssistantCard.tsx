import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Button, Card, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { createCardSource } from "./create-card-source";
import { CREATE_ASSISTANT, shouldShow, type AgentRow } from "./create-card-model";

const source = createCardSource(callT);

/**
 * The card on Now for an owner or admin whose space has no assistant. It shows nothing until the box has answered, and nothing when there is one.
 * `role` is the person's role in the space showing (spaces.list), which the Now screen already has. `agents` may be given to skip the read.
 */
export function CreateAssistantCard({ role, agents }: { role?: string | null; agents?: readonly AgentRow[] | null }) {
  const router = useRouter();
  const [read, setRead] = useState<AgentRow[] | null>(null);
  useEffect(() => {
    if (agents !== undefined) return;
    let live = true;
    void source.agents().then((a) => { if (live) setRead(a); });
    return () => { live = false; };
  }, [agents]);
  if (!shouldShow(agents !== undefined ? agents : read, role)) return null;
  return (
    <Card className="gap-s3">
      <Text strong>{CREATE_ASSISTANT.title}</Text>
      <Text tone="muted">{CREATE_ASSISTANT.body}</Text>
      <Button kind="primary" label={CREATE_ASSISTANT.action} onPress={() => router.push(CREATE_ASSISTANT.href as never)} />
    </Card>
  );
}
