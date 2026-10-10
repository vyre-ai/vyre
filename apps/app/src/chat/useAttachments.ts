import { useCallback, useRef, useState } from "react";
import { tool } from "../real/box";
import { failed, ready, rememberThumb, thumbOf, toSend, uploading, whyNot, without, type Attachment, type Chip } from "./attach-model.js";
import { pickFiles, type Picked } from "./attach-pick";

/**
 * The files being added to the next message in a chat: each is picked (or pasted, or dropped), checked against the box's limits in words, uploaded at once with attachments.put, and shown as a chip until
 * the message is sent. A send takes what is ready and waits on what is still uploading. `chat` is the chat's id (the thread the box keeps the files under).
 */
export function useAttachments(chat: string | undefined) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const live = useRef<Chip[]>([]);
  const n = useRef(0);
  const set = useCallback((next: Chip[]) => { live.current = next; setChips(next); }, []);

  const add = useCallback(async (files: Picked[]) => {
    if (!chat) { setProblem("Start the chat with a message before adding files."); return; }
    setProblem(null);
    for (const f of files) {
      const why = whyNot(live.current, f);
      if (why) { setProblem(why); continue; }
      const key = `a${++n.current}`;
      set([...live.current, uploading(key, f)]);
      try {
        const a = await tool<Attachment>("attachments.put", { thread: chat, name: f.name, mime: f.mime, data: f.base64 });
        rememberThumb(a.id, thumbOf(f));
        set(ready(live.current, key, a));
      } catch (e) {
        const why2 = e instanceof Error && e.message ? e.message : "That file could not be added.";
        set(failed(live.current, key, why2));
        setProblem(why2);
      }
    }
  }, [chat, set]);
  const choose = useCallback(async (photo: boolean) => { try { await add(await pickFiles(photo)); } catch (e) { setProblem(e instanceof Error ? e.message : "The files could not be read."); } }, [add]);
  const remove = useCallback((key: string) => { set(without(live.current, key)); setProblem(null); }, [set]);
  const clear = useCallback(() => { set([]); setProblem(null); }, [set]);
  return { chips, problem, add, choose, remove, clear, take: () => toSend(live.current) };
}
