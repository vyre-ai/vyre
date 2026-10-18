// Add people, over acct6's tools. One chat per set of people: adding someone to a thread with an agent moves that thread into the chat of exactly those people (work.thread.add-people, the agent comes along);
// adding someone to a one-to-one chat starts a new thread in the chat of exactly that set (work.chat.thread.new makes the chat if there is none). The key ring is made on this device either way.
import { getAgreeKey } from "../crypto/agree-key";
import { holdersFor, newChatRing, ringWithPeople } from "../crypto/chat-ring.js";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { tool } from "../real/box";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");
const idOf = (p: string) => String(p).replace(/^person:/, "");

/** Add people to this device's thread with an agent. Null when it is done, else the line to show. */
export async function addToAgentThread(thread: string, people: string[]): Promise<string | null> {
  try {
    const me = await getAgreeKey();
    if (!me) return "This device can't add people to a private chat yet.";
    const made = await ringWithPeople((t, i) => tool(t, i ?? {}), thread, people.map(idOf), me);
    if ("say" in made) return made.say;
    await tool("work.thread.add-people", { thread, people: people.map(idOf), ring: made.ring });
    return null;
  } catch (e) { return say(e); }
}

/** Start a new thread in the chat of exactly you and these people (the one-to-one chat's people and the newcomers). The new thread's id, or the line to show. */
export async function newThreadWith(people: string[]): Promise<{ thread: string } | { say: string }> {
  try {
    const me = await getAgreeKey();
    if (!me) return { say: "This device can't start private chats yet." };
    const who = await tool<{ person?: string }>("records.me", {}).catch(() => null);
    if (!who?.person) return { say: "Vyre could not tell who you are, so nothing was started." };
    const others = people.map(idOf);
    const r = await holdersFor((t, i) => tool(t, i ?? {}), [who.person, ...others], me);
    if (!r.listed) return { say: "This device isn't ready for private chats yet." };
    if (r.without.length) return { say: "Some devices can't open private chats yet." };
    const id = `chat_${newUuid()}`;
    const made = await newChatRing(id, r.holders);
    const out = await tool<{ thread?: string }>("work.chat.thread.new", { people: others, id: made.id, ring: made.ring });
    return out?.thread ? { thread: String(out.thread) } : { say: "Vyre did not say which thread it started." };
  } catch (e) { return { say: say(e) }; }
}
