import { useEffect, useMemo, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { useThreads } from "./threads";
import { chatsFrom, noSuchTool, sampleChats, withNames, type ChatRow } from "../../screens/chats/chats-model.js";

/**
 * The person's chats as one list (CONTRACT-one-chat.md): work.chat.list, and nothing else. A box that does not have it is `unsupported` (the screen says to update the server); the sample world gets its
 * three scripted chats.
 */
export function useChats(): { rows: ChatRow[]; from: "sample" | "chats" | "unsupported" | "none" } {
  const threads = useThreads();
  const [actors, setActors] = useState<unknown>(null);
  const [listed, setListed] = useState<ChatRow[] | "unsupported" | undefined>(undefined);
  const mock = allowsMock();
  useEffect(() => { if (!allowsMock()) tool("records.actors", {}).then(setActors).catch(() => {}); }, []);
  // The box's run list changes whenever a chat does, so it is also the cue to ask for the chat list again.
  useEffect(() => {
    if (mock) return;
    let live = true;
    tool("work.chat.list", {}).then((d) => { if (live) setListed(chatsFrom(d)); }).catch((e: { code?: string }) => { if (live && noSuchTool(e)) setListed("unsupported"); });
    return () => { live = false; };
  }, [mock, threads]);
  return useMemo(() => {
    if (mock) return { rows: sampleChats(Date.now()), from: "sample" as const };
    if (listed === "unsupported") return { rows: [], from: "unsupported" as const };
    if (listed) return { rows: withNames(listed, actors), from: "chats" as const };
    return { rows: [], from: "none" as const };
  }, [mock, listed, actors]);
}
