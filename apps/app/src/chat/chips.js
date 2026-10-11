// @ts-check
// The picked tags of a message, as stream.send takes them: the names to wake (`mentions`) and the AI account the sender chose for it (an @ account chip). A shared chat runs the message on THAT account
// (0.3.3 G04), not on the one the chat's thread started with.

/** @param {{ kind: string, id: string, name?: string }[] | undefined} ms @returns {{ mentions?: string[], account?: string }} */
export function chipsOf(ms) {
  const account = (ms || []).find((m) => m.kind === "account");
  const rest = (ms || []).filter((m) => m.kind !== "account").map((m) => m.id);
  return { ...(rest.length ? { mentions: rest } : {}), ...(account ? { account: account.id } : {}) };
}
