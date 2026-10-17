// @ts-check
// A receipt that GitHub itself confirmed a sign-in. onboard.github.finish exchanges the login code and reads the numeric account id from GitHub, then vouches here.
// identity.github.link claims the receipt once. A login and an id typed into the tool, or sent by an agent, have no receipt and link nothing.

const TTL_MS = 5 * 60_000;
/** @type {Map<string, number>} */
const receipts = new Map();

/** @param {string} login @param {string} subject */
const keyOf = (login, subject) => `${String(login).toLowerCase()}|${String(subject)}`;

/** Record that GitHub confirmed this account. @param {string} login @param {string} subject @param {() => number} [now] */
export function vouch(login, subject, now = Date.now) {
  const t = now();
  for (const [k, exp] of receipts) if (exp <= t) receipts.delete(k);
  receipts.set(keyOf(login, subject), t + TTL_MS);
}

/** Spend the receipt for this account: true once, only after a vouch and inside five minutes. @param {string} login @param {string} subject @param {() => number} [now] */
export function claim(login, subject, now = Date.now) {
  const k = keyOf(login, subject);
  const exp = receipts.get(k);
  receipts.delete(k);
  return exp !== undefined && exp > now();
}
