import { useCallback, useEffect, useMemo, useState } from "react";
import { allowsMock, titleOf, useRecordsWorld } from "@vyre/ui";
import "../api/store-link";
import { tool } from "../real/box";
import { useThread } from "../state/threads";
import { agentsList, providers } from "../../screens/settings/real";
import { modelChoices, peopleFor, recordPicks, switchCall } from "./real-composer.js";
import type { ModelChoice, Person, RecordPick } from "./ChatComposer";

/**
 * What a real chat's composer offers (nothing outside the sample world used to fill these): the models and accounts that can answer, the people and assistants to @mention, and the records to # tag.
 * `here` is the chat's own participants. Switching a model asks the box (threads.model, or threads.switch for another account) and says so when it refuses.
 */
export function useRealComposer(session: string | undefined, here: Person[] | undefined, viewer: string | null, onNote: (s: string | null) => void) {
  const real = !allowsMock() && Boolean(session);
  const thread = useThread(session ?? "");
  const { data: world } = useRecordsWorld();
  const [provRows, setProvRows] = useState<unknown>(null);
  const [actors, setActors] = useState<unknown>(null);
  const [agents, setAgents] = useState<unknown>(null);
  useEffect(() => {
    if (!real) return;
    let live = true;
    void providers().then((r) => live && setProvRows(r)).catch(() => {});
    void tool("records.actors", {}).then((r) => live && setActors(r)).catch(() => {});
    void agentsList().then((r) => live && setAgents(r)).catch(() => {});
    return () => { live = false; };
  }, [real]);
  const current = useMemo(() => ({ provider: (thread as { provider?: string | null } | null)?.provider ?? "claude", account: null as string | null, model: thread?.model ?? null }), [thread]);
  const { models, model } = useMemo(() => modelChoices(provRows, current), [provRows, current]);
  const people: Person[] = useMemo(() => peopleFor({ actors, agents, viewer, here: here ?? [] }), [actors, agents, viewer, here]);
  const records: RecordPick[] = useMemo(() => (world ? recordPicks(world as never, (d: unknown, r: unknown) => titleOf(d as never, r as never)) : []), [world]);
  const onModel = useCallback((id: string, slot?: string) => {
    const c = session ? switchCall(session, id, provRows, current, slot) : null;
    if (!c) return;
    onNote(null);
    void tool(c.tool, c.input).catch((e: Error) => onNote(e.message || "The model did not switch."));
  }, [session, provRows, current, onNote]);
  return real ? { people, records, models: models as ModelChoice[], model, onModel } : null;
}
