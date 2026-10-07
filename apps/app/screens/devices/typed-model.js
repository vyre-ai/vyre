// @ts-check
// Typing a short Wink code (WINK-NNPP-PPPP) on the second device: wink.code.redeem, then wink.pair.status until it ends. Pure, so Node tests it.

export const TYPED = {
  label: "Type the code",
  help: "The code the other device shows, like WINK-7K4Q-M2XD.",
  go: "Use this code",
  busy: "Checking",
  ackLine: "Type this on your other device.",
  waiting: "Waiting for your other device.",
  ackFieldLabel: "The code the other device shows",
  ackGo: "Confirm",
};

/** The words for what the box refused. Never the box's own text. @param {string | undefined} code */
export function redeemSay(code) {
  if (code === "bad_input") return "That is not a Vyre code. It looks like WINK-7K4Q-M2XD.";
  if (code === "refused") return "That code is not the one the other device is showing, or it has been used up. Nothing was paired. Check the code and try again.";
  if (code === "unavailable") return "Your Vyre cannot reach the relay right now. Nothing was paired. Try again in a minute.";
  if (code === "typed_code_off") return "Typed codes are switched off on this Vyre. Scan the code or paste the long link instead.";
  if (code === "relay_old") return "The relay is too old for a typed code. Paste the long link instead.";
  if (code === "presence_required" || code === "needs_presence") return "That needs you. Approve on your phone, then try again.";
  return "That did not work. Nothing was paired.";
}

/** The words for why a typed invite code did not work, from relay/client/join.js redeemInviteCode. @param {string} reason */
export function inviteReasonSay(reason) {
  if (reason === "format") return redeemSay("bad_input");
  if (reason === "busy") return "Too many tries. Wait a minute, then try again.";
  if (reason === "offline") return redeemSay("unavailable");
  if (reason === "expired") return "The code ran out of time, so nothing was joined. Ask for a new one.";
  if (reason === "not_an_invite") return "That code is not an invitation to a space.";
  return redeemSay("refused");
}

/**
 * What wink.pair.status says, as what the screen does next.
 * @param {any} s @returns {{ phase: "waiting" | "confirm" | "done" | "failed", ack?: string, words?: string[], invite?: { link: string, space?: string }, say?: string }}
 */
export function phaseOf(s) {
  const st = String(s?.state ?? "");
  if (st === "done") return { phase: "done", ...(s?.invite && typeof s.invite.link === "string" ? { invite: { link: s.invite.link, ...(s.invite.space ? { space: String(s.invite.space) } : {}) } } : {}) };
  if (st === "confirm") return { phase: "confirm", words: Array.isArray(s?.words) ? s.words.map(String) : [] };
  if (st === "failed") return { phase: "failed", say: redeemSay("refused") };
  if (st === "expired") return { phase: "failed", say: "The code ran out of time, so nothing was paired. Ask for a new one." };
  return { phase: "waiting", ...(typeof s?.ack === "string" && s.ack ? { ack: s.ack } : {}) };
}

/** "9:41" left of a deadline, or "" once it has passed or there is none. @param {number | null | undefined} expires epoch ms @param {number} now */
export function leftOf(expires, now) {
  const ms = Number(expires) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
