// @ts-check
// agent-endpoint: computers.endpoint for an agent that has its own computer. The agent is whoever the verified caller is (resolve: a model session's own claim, never a name it types), someone
// else's computer needs the agents module's say-so, and only then is the agent woken and its Chrome's address and token handed out. Every refusal happens before a thing is made.

/**
 * @param {{ resolve: (input: any, caller: string) => Promise<string>, claimOf: (caller: string) => string | null, mayUse: (need: "use" | "edit", agent: string) => Promise<void>,
 *   place: (agent: string) => Promise<any>, wake: (agent: string) => Promise<any>, endpoint: (agent: string) => Promise<{ url: string, token: string }> }} d
 */
export function makeAgentEndpoint(d) {
  return async (/** @type {any} */ input, /** @type {string} */ caller) => {
    const agent = await d.resolve(input, caller);
    // the caller's own computer needs no further word; anything else (the assistant acting for a person) needs the person to have the agent
    if (d.claimOf(caller) !== agent) await d.mayUse("use", agent);
    await d.place(agent);
    await d.wake(agent);
    return { helper: await d.endpoint(agent) };
  };
}
