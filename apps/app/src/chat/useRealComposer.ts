import { useCallback, useEffect, useMemo, useState } from "react";
import { allowsMock, titleOf, useRecordsWorld, type ModelPick } from "@vyre/ui";
import "../api/store-link";
import { tool } from "../real/box";
import { useThread } from "../state/threads";
import { agentsList } from "../../screens/settings/real";
import { memberNames, peopleFor, recordPicks, switchCall } from "./real-composer.js";
import { useMyModels } from "../models/useMyModels";
import { effortFor } from "../models/model-choice.js";
import type { ModelNow, Person, RecordPick } from "./ChatComposer";

/** The person's own pick in a chat, kept on this device too so the switcher shows it at once after a reload; the box keeps the real one (threads.chat-switch) and runs their turns on it. */
const KEY = (chat: string) => `vyre.chat-model.${chat}`;
const remembered = (chat: string): (ModelNow & { effort?: string | null }) | null => { try { const v = globalThis.localStorage?.getItem(KEY(chat)); return v ? JSON.parse(v) : null; } catch { return null; } };
const remember = (chat: string, v: ModelNow & { effort?: string | null }) => { try { globalThis.localStorage?.setItem(KEY(chat), JSON.stringify(v)); } catch { /* a convenience only */ } };

/**
 * What a real chat's composer offers (nothing outside the sample world used to fill these): the person's own AI accounts and the models each can run (the one model service), the people and assistants
 * to @mention, and the records to # tag. `here` is the chat's own participants. A model pick is the person's own for this chat (threads.chat-switch): it never changes the chat for anyone else, and the
 * box says so in the thread as one quiet line. A refusal is said.
 */
export function useRealComposer(session: string | undefined, here: Person[] | undefined, viewer: string | null, onNote: (s: string | null) => void) {
  const real = !allowsMock() && Boolean(session);
  const thread = useThread(session ?? "");
  const { data: world } = useRecordsWorld();
  const { groups } = useMyModels();
  const [actors, setActors] = useState<unknown>(null);
  const [agents, setAgents] = useState<unknown>(null);
  const [mine, setMine] = useState<(ModelNow & { effort?: string | null }) | null>(() => (session ? remembered(session) : null));
  // the Space's members by name (a username where no other name is known), so the @ list never shows an id
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!real) return;
    let live = true;
    void tool("records.actors", {}).then((r) => live && setActors(r)).catch(() => {});
    void agentsList().then((r) => live && setAgents(r)).catch(() => {});
    void tool<{ space?: string }>("records.me", {}).then((me) => (me?.space ? tool("spaces.members.list", { space: me.space }) : null)).then((m) => { if (live && m) setNames(memberNames(m)); }).catch(() => {});
    return () => { live = false; };
  }, [real]);
  useEffect(() => { setMine(session ? remembered(session) : null); }, [session]);
  // what this person's turns run on: their own pick when they made one, else what the chat runs on
  const model: ModelNow = useMemo(() => mine ?? { provider: (thread as { provider?: string | null } | null)?.provider ?? null, account: null, model: thread?.model ?? null }, [mine, thread]);
  const people: Person[] = useMemo(() => peopleFor({ actors, agents, viewer, here: here ?? [], names }), [actors, agents, viewer, here, names]);
  const records: RecordPick[] = useMemo(() => (world ? recordPicks(world as never, (d: unknown, r: unknown) => titleOf(d as never, r as never)) : []), [world]);
  const send = useCallback((pick: ModelPick, slot: string | undefined, effort: string | null) => {
    const c = session ? switchCall(session, pick, slot, effort) : null;
    if (!c || !session) return;
    onNote(null);
    const next = { account: pick.account.id, provider: pick.model.provider, model: pick.model.id, effort };
    void tool(c.tool, c.input).then(() => { setMine(next); remember(session, next); }).catch((e: Error) => onNote(e.message || "The model did not switch."));
  }, [session, onNote]);
  const onModel = useCallback((pick: ModelPick, slot?: string) => send(pick, slot, effortFor(pick.model, mine?.effort) || null), [send, mine]);
  const onEffort = useCallback((effort: string, slot?: string) => {
    const g = groups ?? [];
    const acct = g.find((x) => x.account.id === model.account) ?? g.find((x) => x.models.some((m) => m.id === model.model));
    const m = acct?.models.find((x) => x.id === model.model);
    if (acct && m) send({ account: acct.account, model: m }, slot, effort);
  }, [groups, model, send]);
  return real ? { people, records, models: groups, model, effort: mine?.effort ?? null, onModel, onEffort } : null;
}
