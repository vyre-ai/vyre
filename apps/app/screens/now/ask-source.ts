// The Home ask box over an injected `call`: a new thread with the agent (work.agent.thread.new), then the words as its first message (stream.send, as the chat composer sends them).
import { route, titleOf } from "./ask-model.js";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type Ring = () => Promise<{ say?: string; id?: string; ring?: unknown }>;

export function askSource(call: Call, o: { ring: Ring; surface: string; zone: string; uuid: () => string }) {
  return {
    /** Start the thread and send the first message; the thread's id, or the words to show when it did not work. */
    async ask(text: string, names: string[], assistant: string): Promise<{ thread: string } | { problem: string }> {
      const to = route(text, names, assistant);
      if (!to.text) return { problem: "Type what you want to ask." };
      if (!to.agent) return { problem: "There is no assistant to ask yet." };
      const made = await o.ring();
      if (made.say) return { problem: made.say };
      const t = await call<{ thread?: string }>("work.agent.thread.new", { agent: to.agent, title: titleOf(to.text), ...made });
      const id = t.data?.thread;
      if (t.error || typeof id !== "string" || !id) return { problem: t.error?.message || "No thread came back." };
      const s = await call("stream.send", { chat: id, text: to.text, message: o.uuid(), surface: o.surface, tz: o.zone });
      return s.error ? { problem: s.error.message } : { thread: id };
    },
  };
}
