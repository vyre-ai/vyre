import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { useThreads } from "./threads";
import { viewCache } from "./cache";
import { useSpaces } from "../../screens/shell/state";
import { createLanding } from "../../ui/query-order.js";
import { LIST_BUDGET_MS, chatsKey, packChats, pickChats, unpackChats } from "../../screens/chats/chats-cache.js";
import { chatsFrom, noSuchTool, sampleConvoChats, withNames, type ChatRow } from "../../screens/chats/chats-model.js";

type From = "sample" | "chats" | "unsupported" | "failed" | "none";

/**
 * The person's chats as one list (CONTRACT-one-chat.md): work.chat.list, and nothing else. A box that does not have it is `unsupported` (the screen says to update the server); the sample world gets its
 * three scripted chats. Stale while revalidate (screens/chats/chats-cache.js): this Space's last list draws at once, and every answer lands unless a later one already has (ui/query-order.js), so a busy
 * box re-asking on each thread event can no longer hold the list on its placeholder. A read that fails or runs past its budget with nothing to show is `failed`, never a skeleton that stays.
 */
export function useChats(): { rows: ChatRow[]; from: From; stale: boolean; note: boolean; retry: () => void } {
  const threads = useThreads();
  const space = useSpaces((s) => s.space);
  const key = chatsKey(space);
  const [actors, setActors] = useState<unknown>(null);
  const [me, setMe] = useState<string | null>(null);
  const [listed, setListed] = useState<{ key: string; rows: ChatRow[] | "unsupported" } | undefined>(undefined);
  const [kept, setKept] = useState<{ key: string; rows: ChatRow[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const order = useRef(createLanding());
  // the Space each answer is for: an answer for a Space no longer showing is dropped, never filed under the new one
  const keptNow = useRef<{ key: string; rows: ChatRow[] } | null>(null);
  keptNow.current = kept;
  const emptyTries = useRef(0);
  const keyNow = useRef(key);
  keyNow.current = key;
  const mock = allowsMock();
  useEffect(() => {
    if (allowsMock()) return;
    tool("records.actors", {}).then(setActors).catch(() => {});
    tool<{ person?: string; me?: string; id?: string }>("records.me", {}).then((m) => setMe(m?.person ?? m?.me ?? m?.id ?? null)).catch(() => {});
  }, []);
  // This Space's last list, drawn until the box answers.
  useEffect(() => {
    if (mock) return;
    let live = true;
    void viewCache.get(key).then((raw) => { const rows = unpackChats(raw) as ChatRow[] | null; if (live && rows) setKept({ key, rows }); }).catch(() => {});
    return () => { live = false; };
  }, [mock, key]);
  // The box's run list changes whenever a chat does, so it is also the cue to ask for the chat list again.
  useEffect(() => {
    if (mock) return;
    const k = key, n = order.current.start();
    const late = setTimeout(() => { if (keyNow.current === k) setFailed(k); }, LIST_BUDGET_MS);
    tool("work.chat.list", {}).then((d) => {
      if (keyNow.current !== k || !order.current.land(n)) return;
      const rows = chatsFrom(d);
      // A box that answers empty while this device kept a list is asked once more before the list is replaced: a server still starting answers empty, and "No chats yet" must mean it.
      const had = keptNow.current;
      if (!rows.length && had && had.key === k && had.rows.length && emptyTries.current < 1) { emptyTries.current += 1; setTimeout(() => { if (keyNow.current === k) setAgain((x) => x + 1); }, 1500); return; }
      emptyTries.current = 0;
      setListed({ key: k, rows });
      setFailed(null);
      void viewCache.set(k, packChats(rows));
    }).catch((e: { code?: string }) => {
      if (keyNow.current !== k) return;
      if (noSuchTool(e)) { if (order.current.land(n)) setListed({ key: k, rows: "unsupported" }); }
      else setFailed(k);
    }).finally(() => clearTimeout(late));
  }, [mock, threads, key, again]);
  const retry = useCallback(() => setAgain((x) => x + 1), []);
  return useMemo(() => {
    if (mock) return { rows: sampleConvoChats(Date.now()), from: "sample" as const, stale: false, note: false, retry };
    const got = pickChats<ChatRow>({ fresh: listed && listed.key === key ? listed.rows : undefined, kept: kept && kept.key === key ? kept.rows : null, failed: failed === key });
    return { ...got, rows: got.rows.length ? withNames(got.rows, actors, me) : got.rows, retry };
  }, [mock, listed, kept, failed, key, actors, me, retry]);
}
