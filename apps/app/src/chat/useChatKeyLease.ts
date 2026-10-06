import { useEffect } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { getAgreeKey } from "../crypto/agree-key";
import { lendChatKey } from "../crypto/chat-ring.js";

/** Opening a sealed chat lends its key to the server for the session, so agents and the Drive can work in it for the participants (work.chat.keys.status says whether it is sealed and already lent). A chat in the clear, or a device with no agreement key, does nothing. */
export function useChatKeyLease(chat: string): void {
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    void (async () => {
      const me = await getAgreeKey();
      if (!me || !live) return;
      const st = await tool<{ sealed?: boolean; lent?: boolean }>("work.chat.keys.status", { chat }).catch(() => null);
      if (!st || st.sealed !== true || st.lent === true || !live) return;
      await lendChatKey((t, i) => tool(t, i ?? {}), chat, me).catch(() => {});
    })();
    return () => { live = false; };
  }, [chat]);
}
