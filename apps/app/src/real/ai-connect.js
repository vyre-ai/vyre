// @ts-check
// The sign-in a computer keeps itself, for a provider that runs on the login already on that computer (today Claude's setup token, onboard.claude): the computer starts the sign-in, the person
// finishes it in a browser and brings back a code, the computer keeps the credential in the vault. AI accounts draws it in the same panel as every provider's own sign-in; there is no card of its
// own. Pure: no calls.

/** The input of onboard.claude for each move. */
export const startInput = () => ({ mode: "setup-token" });
/** @param {string} code */
export const codeInput = (code) => ({ mode: "setup-token", code: code.trim() });

/** Disconnect: removes the sign-in from the vault (person-only, with presence like connect). */
export const disconnectInput = () => ({ mode: "disconnect" });
export const DISCONNECT_NOTE = "Assistants on it stop and ask you. The account itself is not touched.";

/** Is this a sign-in link the person may open? Only https, never anything else. @param {unknown} url */
export const safeLink = (url) => { try { const u = new URL(String(url)); return u.protocol === "https:" ? u.toString() : null; } catch { return null; } };

/** What the person is told when the code they pasted belongs to another sign-in than the one they opened. */
export const WRONG_FLOW = "That code is from a different sign-in. Open the sign-in again.";

/**
 * Claude's code is shown as `code#state`; the state is the one in the sign-in link the home gave (its `state` parameter). A code whose state is not this link's came from another sign-in (an older tab, a
 * second Open the sign-in): saying so beats a refusal that says nothing. A code with no state, or a link with none, is not judged here.
 * @param {string} pasted @param {string | null | undefined} link
 */
export function codeMatchesFlow(pasted, link) {
  const at = String(pasted ?? "").indexOf("#");
  if (at < 0 || !link) return true;
  let want = "";
  try { want = new URL(String(link)).searchParams.get("state") || ""; } catch { return true; }
  const got = String(pasted).slice(at + 1).trim();
  return !want || !got || got === want;
}

/** The first step on a computer with no owner, by where the person is: a browser cannot make a name in this release, a Mac window of Vyre can. @param {"browser" | "mac" | "phone"} [surface] */
export const nameFirstLine = (surface = "mac") => (surface === "browser" ? "Choose your Vyre name on your phone first. Then connect an AI account." : surface === "phone" ? "Choose your Vyre name on this phone first. Then connect an AI account." : "Make your Vyre name on this computer first. Then connect an AI account.");

/** @param {string | undefined} code @param {string} message @param {"browser" | "mac" | "phone"} [surface] */
export function aiRefusal(code, message, surface) {
  if (code === "not_allowed" || code === "denied") return "This computer's own sign-in belongs to its owner. Add your own AI account with Sign in or Use an API key.";
  if (code === "not_a_server") return nameFirstLine(surface);
  if (code === "pair_first") return "Pair this server to your Vyre app first. Then connect an AI account.";
  if (code === "presence_required" || code === "needs_presence") return "That needs you. Approve on this device, then try again.";
  if (code === "expired" || code === "timeout") return "The sign-in ran out of time. Nothing was connected. Start over.";
  if (code === "bad_code" || code === "invalid_code") return "That code did not work. Copy it again from the sign-in page and paste it here. Nothing was connected.";
  if (code === "offline") return "Your computer did not answer, so nothing was saved. Try again.";
  return message || "That did not connect. Nothing was saved. Try again.";
}

/** What the assistant says while no account is connected, and where to connect one. */
export const NO_ACCOUNT_SAY = "I have no AI account yet. Connect one in Settings, AI accounts.";
