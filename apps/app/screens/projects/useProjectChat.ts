import { useEffect, useState } from "react";
import { callT } from "../../src/real/call-tool";
// @ts-ignore a plain .js module
import { chatAnswer } from "./chat.js";

export type ProjectChat = { state: "loading" } | { state: "missing" } | { state: "failed"; why: string } | { state: "open"; chat: string; missing: string[]; extra: string[] };

/**
 * A project's group chat (work.project.chat { project } -> { chat, missing[], extra[] }; the server makes the chat and keeps its people in step). While the tool is not on this box the state is "missing" and the
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
