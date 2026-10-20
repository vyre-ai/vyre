// @ts-check
// plain: what the Computer tab says when an agent's computer cannot run, one sentence per state, in words a person can act on.
// The driver's own messages (Docker's, the proxy's) stay in vyred's log; a person sees these.

/** No computer driver: computers are not on for this server. */
export const NO_DRIVER_WORDS = "Agent computers aren't set up on this server yet. Update the server to turn them on.";
/** The driver cannot run commands in a computer (the fake, a test machine). */
export const NO_EXEC_WORDS = "This server can't run agents' computers. They run on a Vyre server installed with the server install line.";
/** The computer image is not on the server: create answered "No such image". */
export const IMAGE_MISSING_WORDS = "The agent computer's image isn't on this server yet. Update the server to download it.";
/** The docker-api proxy refused the create (its policy and vyred's settings differ). */
export const PROXY_REFUSED_WORDS = "This server's computer service refused to start the agent computer because its settings don't match. Update the server to fix it.";
/** The docker-api proxy is not answering, or has no bearer yet. */
export const PROXY_DOWN_WORDS = "This server's computer service isn't answering yet. Try again in a minute. If it keeps saying this, restart the server.";
/** The computer was made but stopped or never answered. */
export const NOT_STARTED_WORDS = "The agent computer did not start. Try again in a minute. If it keeps failing, update the server.";

/**
 * The plain sentence and error code for a failure to bring an agent's computer up, or null when the message is not one of the driver's own
 * (a refusal about access, a bad name and the like already speak to the person, and pass through unchanged).
 * @param {unknown} err
 * @returns {{ code: string, message: string } | null}
 */
export function plainComputerError(err) {
  const m = String(err && typeof err === "object" && "message" in err ? /** @type {any} */ (err).message : err || "");
  if (/no computer driver is configured|computers\.docker is not set|aren't set up on this server/i.test(m)) return { code: "unavailable", message: NO_DRIVER_WORDS };
  if (/no such image|pull access denied|image .* not found/i.test(m)) return { code: "computer_unavailable", message: IMAGE_MISSING_WORDS };
  if (/vyre docker proxy: (no bearer yet|missing or wrong bearer)/i.test(m)) return { code: "computer_unavailable", message: PROXY_DOWN_WORDS };
  if (/vyre docker proxy:/i.test(m)) return { code: "computer_unavailable", message: PROXY_REFUSED_WORDS };
  if (/^docker [A-Z]+ \S+: .*(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|timed out)/.test(m)) return { code: "computer_unavailable", message: PROXY_DOWN_WORDS };
  if (/driver cannot run commands|cannot run commands in the Space's computer/i.test(m)) return { code: "unavailable", message: NO_EXEC_WORDS };
  if (/container is not running|stopped as soon as it started|did not answer|is not set up on this machine/i.test(m)) return { code: "computer_unavailable", message: NOT_STARTED_WORDS };
  return null;
}

/**
 * The same error, in plain words when it is one of the driver's own; the original message is kept on `.detail` for the log.
 * @param {unknown} err
 * @returns {Error}
 */
export function plainError(err) {
  const p = plainComputerError(err);
  const e = err instanceof Error ? err : new Error(String(err));
  if (!p) return e;
  return Object.assign(new Error(p.message), { code: p.code, detail: e.message });
}
