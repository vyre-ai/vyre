import { useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { membersFrom, runThreadOf, slotNames, whereLine, type Member } from "./members.js";

/**
 * Who is in a real chat before its stream says (work.chat.get: people by id, agents by name), with each person's name from records.actors. Empty in the sample world and while the box has not answered, so
 * nothing invented is ever shown. `me` is the viewer's person id.
 */
export function useChatMembers(chat: string, rev: unknown = 0): { members: Member[]; me: string | null; thread: string | null; slots: { id: string; name: string }[]; where: string | null } {
  const [state, setState] = useState<{ members: Member[]; me: string | null; thread: string | null; slots: { id: string; name: string }[]; where: string | null }>({ members: [], me: null, thread: null, slots: [], where: null });
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    void Promise.all([tool("work.chat.get", { chat }).catch(() => null), tool("records.actors", {}).catch(() => null), tool<{ person?: string }>("records.me", {}).catch(() => null), tool("runner.places", {}).catch(() => null)])
      .then(([got, actors, me, places]) => { if (live) setState({ members: membersFrom(got, actors, me?.person ?? null), me: me?.person ?? null, thread: runThreadOf(got), slots: slotNames(got), where: got ? whereLine(places, chat) : null }); });
    return () => { live = false; };
  }, [chat, rev]);
  return state;
}
