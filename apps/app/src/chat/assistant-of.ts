// The person's assistant, for a chat that lists nobody: the pinned assistant chat acts as the person, so the header and the Threads tab still need the assistant's name and face.
import { useEffect, useState } from "react";
import { agentsList } from "../../screens/settings/real";

export type AssistantFace = { id: string; name: string };

/** The assistant's id (what work.agent.threads takes) and the name a person reads. Empty until the list answers. */
export function useAssistant(): AssistantFace | null {
  const [face, setFace] = useState<AssistantFace | null>(null);
  useEffect(() => {
    let live = true;
    void agentsList().then((list) => {
      const row = (list || []).find((x) => x && x.kind === "assistant");
      if (!live || !row?.name) return;
      setFace({ id: String(row.name), name: String(row.name) });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return face;
}
