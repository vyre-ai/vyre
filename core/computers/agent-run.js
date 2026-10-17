// @ts-check
// agent-run: computers.run.open, the way a harness session (Claude Code, Codex, Grok) starts INSIDE an agent's computer, as that agent's own Linux user. It registers a one-use ticket with agentd's
// relay that carries what to run, and answers where the relay is and the word to say to it. The caller connects, says the ticket, and then talks frames (agentd-run.py): standard input down,
// standard output, standard error and the exit up, kept separate. The agent is whoever the verified caller is (resolve: a model session's own claim, never a name it types); someone else's computer
// needs the right to edit the agent. The command, folder and variables are checked here, by agentd, and again by the helper as the agent. Nothing secret travels here: a provider token is an
// ordinary variable the caller names (the per-session token for Vyre's provider proxy, never a real key).

import crypto from "node:crypto";

/**
 * @param {{ resolve: (input: any, caller: string) => Promise<string>, claimOf: (caller: string) => string | null, mayUse: (need: "use" | "edit", agent: string) => Promise<void>,
 *   place: (agent: string) => Promise<any>, wake?: (agent: string) => Promise<any>, ticket: (agent: string, hello: string, spec: any) => Promise<void>, where: () => Promise<{ host: string, port: number }> }} d
 */
export function makeAgentRun(d) {
  return async (/** @type {any} */ input, /** @type {string} */ caller) => {
    const agent = await d.resolve(input, caller);
    // a session of the agent's own needs no further word; anything else (the runner acting for a person) needs the right to edit the agent: it runs code as the agent
    if (d.claimOf(caller) !== agent) await d.mayUse("edit", agent);
    const spec = { argv: input.argv, cwd: input.cwd, env: input.env };
    await d.place(agent);
    const at = await d.where().catch(e => { throw Object.assign(new Error(`this agent's computer could not start: ${/** @type {Error} */ (e).message}`), { code: "computer_unavailable" }); });
    const hello = crypto.randomBytes(24).toString("base64url");
    try { await d.ticket(agent, hello, spec); }
    catch (e) {
      // a refusal of the command is the caller's to read; a computer that did not answer is "unavailable"
      const m = String(/** @type {Error} */ (e).message);
      throw Object.assign(new Error(m), { code: /could not ticket \(400/.test(m) ? "bad_input" : "computer_unavailable" });
    }
    return { agent, host: at.host, port: at.port, hello: `${hello}\n` };
  };
}
