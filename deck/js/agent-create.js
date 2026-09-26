// @ts-check
// Making an agent from the Deck, with its computer if the form asked for one. The New agent form
// (views/agents.js) and Create your assistant (assistant-setup.js) both tick "Give it its own
// computer, from the pool". agents.create records `computer`, but a vyred whose agents.create
// dropped it made the agent without one, while the agent page's "Give <name> a computer" button
// (agents.update { name, computer: true }) worked. So after making the agent, when the box asked
// for a computer and the agent came back without one, this sends that same agents.update.
//
//   createAgent(input, call)   { data: the agent as vyred has it, error, computerError }
//                              error: agents.create was refused and nothing was made
//                              computerError: the agent was made, but giving it a computer was refused
//                              call is api.js's attempt, passed in so this has no page to load

/**
 * @param {Record<string, any> & { name: string, computer?: boolean }} input agents.create's input
 * @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} call
 * @returns {Promise<{ data: any, error: any, computerError: any }>}
 */
export async function createAgent(input, call) {
  const r = await call("agents.create", input);
  if (r.error) return { data: null, error: r.error, computerError: null };
  const made = r.data && typeof r.data === "object" ? r.data : null;
  if (!input.computer || made?.computer === true) return { data: made, error: null, computerError: null };
  const u = await call("agents.update", { name: input.name, computer: true });
  // The agent exists either way; a refused update is said, and the agent page still offers the button.
  if (u.error) return { data: { ...made, computer: false }, error: null, computerError: u.error };
  const after = u.data && typeof u.data === "object" && "computer" in u.data ? u.data : { ...made, computer: true };
  return { data: after, error: null, computerError: null };
}
