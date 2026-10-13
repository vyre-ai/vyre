import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, LoadingState } from "@vyre/ui";
import { Page } from "../places/Frame";
import { ensurePersistent } from "../../src/state/persistent-chat";
import { boxStream } from "../../src/chat/box-stream";
import { tool } from "../../src/real/box";
import { contextCard, handoffText, openRefusal, takeHandoff } from "./model.js";
import { readShape } from "./source.js";

const call = async (name: string, input: Record<string, unknown> = {}) => {
  try { return { data: await tool<any>(name, input) }; } catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
};

/**
 * /u/engineer: your one chat with @Engineer. It finds or makes the person's pinned chat and opens it: the standard chat screen, nothing of its own. When a "Describe it" sent
 * the person here (openEngineer), the thing's current shape is read with their own access, a context card is built and sent into the chat at once, so the Engineer starts on that
 * specific thing without being asked again.
 */
export function EngineerEntry() {
  const router = useRouter();
  const [say, setSay] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      const opened = await ensurePersistent("engineer");
      if (!live) return;
      if ("say" in opened) { setSay(opened.say); return; }
      const h = takeHandoff();
      if (h) {
        const found = await readShape(call, h);
        const why = await boxStream(opened.chat).sendText(handoffText(contextCard(h, found)));
        if (why && live) { setSay(`The chat is open, but the request was not sent: ${why}`); router.replace({ pathname: "/u/chats/[id]", params: { id: opened.chat } }); return; }
      }
      if (live) router.replace({ pathname: "/u/chats/[id]", params: { id: opened.chat } });
    })().catch((e) => { if (live) setSay(openRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); });
    return () => { live = false; };
  }, [router]);
  return (
    <Page title="Engineer" sub="Set up your Space by talking to it." back="/u/settings">
      {say ? <Card><EmptyState title="The Engineer chat did not open" body={say} action={{ label: "Back", onPress: () => router.replace("/u/settings" as never) }} /></Card> : <LoadingState rows={2} />}
      {say ? null : <Button kind="ghost" size="sm" label="Back" onPress={() => router.back()} />}
    </Page>
  );
}
