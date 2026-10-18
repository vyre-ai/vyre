import { useEffect, useState } from "react";
import { callT } from "../../src/real/call-tool";
// @ts-ignore a plain .js module
import { chatAnswer } from "./chat.js";

export type ProjectChat = { state: "loading" } | { state: "missing" } | { state: "making" } | { state: "waiting" } | { state: "pending" } | { state: "failed"; why: string } | { state: "open"; chat: string; adding: number; readOnly: boolean };

/**
 * A project's group chat (work.project.chat { project } -> { chat, member, missing[], extra[], readonly_for_you }; the server makes the chat, a device in it keeps its people in step). While the tool is not on this box the state is "missing" and the
 * screen shows nothing, so the button lights up on its own once the tool exists.
 */
export function useProjectChat(project: string): ProjectChat {
  const [s, setS] = useState<ProjectChat>({ state: "loading" });
  useEffect(() => {
    let live = true;
    if (!project) { setS({ state: "missing" }); return () => {}; }
    callT("work.project.chat", { project }).then((r) => { if (live) setS(chatAnswer(r)); });
    return () => { live = false; };
  }, [project]);
  return s;
}
