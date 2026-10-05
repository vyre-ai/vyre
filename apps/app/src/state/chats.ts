import { useEffect, useMemo, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { useThreads } from "./threads";
import { chatsFrom, fromThread, sampleChats, type ChatRow } from "../../screens/chats/chats-model.js";

/**
 * The person's chats as one list (CONTRACT-one-chat.md): work.chat.list when the box has it, else the older session list made into the same rows. `from` says which, for the one place that cares
 * (a row's `open` flag only comes from work.chat.list). The sample world gets its three scripted chats.
 */
export function useChats(): { rows: ChatRow[]; from: "sample" | "chats" | "sessions" | "none" } {
  const threads = useThreads();
  const [listed, setListed] = useState<ChatRow[] | null | undefined>(undefined);
  const mock = allowsMock();
  // The session list changes whenever a chat does, so it is also the cue to ask for the chat list again.
  useEffect(() => {
    if (mock) return;
    let live = true;
    tool("work.chat.list", {}).then((d) => { if (live) setListed(chatsFrom(d)); }).catch(() => { if (live) setListed(null); });
    return () => { live = false; };
  }, [mock, threads]);
  return useMemo(() => {
    if (mock) return { rows: sampleChats(Date.now()), from: "sample" as const };
    if (listed) return { rows: listed, from: "chats" as const };
    if (listed === null && threads.length) return { rows: threads.map(fromThread), from: "sessions" as const };
    return { rows: [], from: "none" as const };
  }, [mock, listed, threads]);
}
