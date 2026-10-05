// @ts-check
// Is anyone signed in? The records and tasks screens each ask the box for the person's data, and a box with no signed-in person refuses every one of them (code denied, "not from a signed-in
// person"). So the shell asks once, with one cheap read, before it mounts a screen: a refusal like that shows the sign-in state and nothing else calls the box.

/** Is this refusal "nobody is signed in"? @param {{ code?: string, message?: string } | null | undefined} error */
export const signedOut = (error) => Boolean(error) && String(error?.code) === "denied" && /signed-in person/i.test(String(error?.message ?? ""));

/**
 * @param {(tool: string, input?: Record<string, unknown>) => Promise<{ error?: { code?: string, message?: string } }>} call
 * @returns {Promise<"in" | "out">} "in" also when the box could not be asked: the screens then say what went wrong themselves
 */
export async function whoIsThere(call) {
  try { const r = await call("records.me"); return signedOut(r.error) ? "out" : "in"; } catch { return "in"; }
}
