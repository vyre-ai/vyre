// @ts-check
// A chat turn's record and collection picks, read under the ASKER's own chain. A group-chat turn reaches the Switchboard as module:stream, so the call itself carries no person: the asker is the id
// the stream names and the kernel has already checked is in the chat (assertAsker, before anything here runs). The chain built from that id is the one the daemon builds for the same person's
// turn session (a device chain for that one person), so what a member may not read is not tagged for them, whatever the owner could read. The Switchboard never holds the chain: it asks for the tags.
import { recordTags } from "../switchboard/record-tags.js";

/**
 * @param {{ kernel: any, personChainFor: (person: string) => any }} o
 * @returns {(q: { asker: string, space?: string | null, chips: any[] }) => Promise<{ chips: any[], tags: any[] }>}
 */
export function turnRecordTags({ kernel, personChainFor }) {
  return async ({ asker, space, chips }) => {
    // A team Space's chat is read by that Space's own kernel, not this one: nothing is tagged here for it (fail closed, plain words).
    const chain = asker && (!space || space === kernel.id.space) ? await Promise.resolve(personChainFor(String(asker))).catch(() => null) : null;
    return recordTags(chips, { kernel: { space: kernel.id.space, records: kernel.gateway.records }, chain });
  };
}
