import { useEffect, useState } from "react";
import { callT } from "../../src/real/call-tool";
import { ensureProjectChat } from "../../src/chat/project-chat";
// @ts-ignore a plain .js module
import { chatAnswer, chatState } from "./chat.js";

export type ProjectChat = { state: "loading" } | { state: "missing" } | { state: "making" } | { state: "waiting" } | { state: "pending" } | { state: "failed"; why: string } | { state: "open"; chat: string; adding: number; readOnly: boolean };

/**
 * A project's group chat. Opening the page runs ensureProjectChat (it makes the chat with a ring made on this device if none exists, adds the teammates who are missing and takes out those who should not be there),
 * then reads work.project.chat for what the button needs to say: read only, still adding, or a viewer before anyone made it. A team member never sees that nobody made it: opening the page makes it.
 */
export function useProjectChat(project: string): ProjectChat {
  const [s, setS] = useState<ProjectChat>({ state: "loading" });
  useEffect(() => {
    let live = true;
    if (!project) { setS({ state: "missing" }); return () => {}; }
    (async () => {
      const ensured = await ensureProjectChat(project);
      const read = chatAnswer(await callT("work.project.chat", { project }));
      if (live) setS(chatState(ensured, read));
    })();
    return () => { live = false; };
  }, [project]);
  return s;
}
