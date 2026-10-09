import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, LoadingState } from "@vyre/ui";
import { Page } from "../places/Frame";
import { ensurePersistent } from "../../src/state/persistent-chat";

/** /u/settings/engineer: your one chat with @Engineer, the agent that sets the Space up by conversation (templates, Flows, agents, skills). It is the same chat as any other, kept going for good; it is reached from here and only by an owner or an admin. */
export default function EngineerChat() {
  const router = useRouter();
  const [say, setSay] = useState("");
  useEffect(() => {
    let live = true;
    void ensurePersistent("engineer").then((r) => { if (!live) return; if ("chat" in r) router.replace({ pathname: "/u/chats/[id]", params: { id: r.chat } }); else setSay(r.say); }).catch((e) => { if (live) setSay(e instanceof Error ? e.message : "Your Vyre did not answer."); });
    return () => { live = false; };
  }, [router]);
  return (
    <Page title="Engineer" sub="Set up your Space by talking to it." back="/u/settings">
      {say ? <Card><EmptyState title="The Engineer chat did not open" body={say} action={{ label: "Back to Settings", onPress: () => router.replace("/u/settings" as never) }} /></Card> : <LoadingState rows={2} />}
      {say ? null : <Button kind="ghost" size="sm" label="Back" onPress={() => router.back()} />}
    </Page>
  );
}
