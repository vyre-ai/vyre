import { useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { membersFrom, type Member } from "./members.js";

/**
 * Who is in a real chat before its stream says (work.chat.get: people by id, agents by name), with each person's name from records.actors. Empty in the sample world and while the box has not answered, so
 * nothing invented is ever shown. `me` is the viewer's person id.
 */
export function useChatMembers(chat: string): { members: Member[]; me: string | null } {
  const [state, setState] = useState<{ members: Member[]; me: string | null }>({ members: [], me: null });
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    void Promise.all([tool("work.chat.get", { chat }).catch(() => null), tool("records.actors", {}).catch(() => null), tool<{ person?: string }>("records.me", {}).catch(() => null)])
      .then(([got, actors, me]) => { if (live) setState({ members: membersFrom(got, actors, me?.person ?? null), me: me?.person ?? null }); });
    return () => { live = false; };
  }, [chat]);
  return state;
}
