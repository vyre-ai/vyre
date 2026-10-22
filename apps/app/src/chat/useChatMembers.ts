import { useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { MEMBERSHIP_MS, awayOf, membersFrom, runThreadOf, slotNames, whereLine, type Member } from "./members.js";

/** One work.chat.get, kept so search can tell a removal from a missed read. */
export type ChatRead = { me: string | null; got: unknown; err: { code?: string; message?: string } | null };

type Here = { members: Member[]; me: string | null; thread: string | null; slots: { id: string; name: string }[]; where: string | null; away: { machine?: string; name?: string } | null; places: unknown; read: ChatRead | null };

const empty = (): Here => ({ members: [], me: null, thread: null, slots: [], where: null, away: null, places: null, read: null });

/**
 * Who is in a real chat before its stream says (work.chat.get: people by id, agents by name), with each person's name from records.actors. Empty in the sample world and while the box has not answered, so
 * nothing invented is ever shown. `me` is the viewer's person id. While the chat stays open it asks again, so a removal that never arrives as a leave frame is still seen. A missed read keeps the roster.
 */
export function useChatMembers(chat: string, rev: unknown = 0): Here {
  const [state, setState] = useState<Here>(empty);
  useEffect(() => {
    if (allowsMock()) return;
    let live = true;
    const load = () => {
      const get = tool("work.chat.get", { chat }).then((got) => ({ got: got as unknown, err: null as ChatRead["err"] })).catch((e: { code?: string; message?: string }) => ({ got: null, err: { code: e?.code, message: e?.message } }));
      void Promise.all([get, tool("records.actors", {}).catch(() => null), tool<{ person?: string }>("records.me", {}).catch(() => null), tool("runner.places", {}).catch(() => null), tool<{ device?: { eid?: string } }>("spaces.devices.list", {}).catch(() => null)])
        .then(([packet, actors, me, places, devs]) => {
          if (!live) return;
          const person = me?.person ?? null;
          const { got, err } = packet;
          const refused = err?.code === "not_found" || /no such chat/i.test(err?.message || "");
          const local = devs?.device?.eid ?? null;
          const read = { me: person, got, err };
          setState((s) => (got || refused ? {
            members: membersFrom(got, actors, person), me: person, thread: runThreadOf(got), slots: slotNames(got),
            where: got ? whereLine(places, chat) : null, away: awayOf(places, chat, local), places, read,
          } : { ...s, read }));
        });
    };
    load();
    const t = setInterval(load, MEMBERSHIP_MS);
    return () => { live = false; clearInterval(t); };
  }, [chat, rev]);
  return state;
}
