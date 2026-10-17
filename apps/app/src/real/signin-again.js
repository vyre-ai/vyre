// @ts-check
// "Sign in again" cards on Now (G26): a website whose login ran out, a security check on a site, a browser with no login, a Connection whose key the service refused. The box already writes each as one `signin` item in the one
// waiting list (approvals.items, core/approvals/items.js) with the words and the buttons; this reads them, keeps only what the app may run, and says where a check left things. Nothing here holds a cookie or a key.

/** The calls a card's button may make: a re-check of the Connection, and "I cleared the security check". Anything else the box names is not run from here. */
const RUNS = new Set(["connectors.connection.check", "connectors.site.resume"]);

/** @typedef {{ label: string, open?: string, tool?: string, input?: Record<string, unknown> }} Button */
/** @typedef {{ id: string, title: string, detail: string, at: number, buttons: Button[] }} SignInCard */

/** @param {any} b @returns {Button | null} */
function buttonOf(b) {
  const label = typeof b?.label === "string" ? b.label.trim().slice(0, 40) : "";
  if (!label) return null;
  if (typeof b.open === "string" && /^\/u\/[A-Za-z0-9_\/-]{1,80}$/.test(b.open)) return { label, open: b.open };
  if (typeof b.tool === "string" && RUNS.has(b.tool) && b.input && typeof b.input.id === "string") return { label, tool: b.tool, input: { id: b.input.id } };
  return null;
}

/** The cards from approvals.items, oldest first. @param {any} answer @returns {SignInCard[]} */
export function signinCards(answer) {
  const items = Array.isArray(answer?.items) ? answer.items : [];
  return items.filter((/** @type {any} */ i) => i && i.kind === "signin" && typeof i.id === "string" && typeof i.title === "string")
    .map((/** @type {any} */ i) => ({ id: i.id, title: i.title, detail: typeof i.detail === "string" ? i.detail : "", at: Number(i.at) || 0, buttons: (Array.isArray(i.answers) ? i.answers : []).map(buttonOf).filter(Boolean) }))
    .filter((/** @type {SignInCard} */ c) => c.buttons.length)
    .sort((/** @type {SignInCard} */ a, /** @type {SignInCard} */ b) => a.at - b.at);
}

/** What to say after a re-check: the Connection's light, as the box answered it. @param {any} r connectors.connection.check's answer */
export const afterCheck = (r) => (r && r.light && r.light !== "green" && r.light !== "ok" ? "Still waiting. Sign in on the site, then check again." : "");

/** The calls a new-device card's buttons make, and the one input each takes: the device id the box gave, checked here before it is used. */
export const DEVICE_CALLS = Object.freeze({ revoke: "identity.signin.revoke", ack: "identity.signin.ack" });
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The cards for the person's own sign-ins on a new device (identity.signins.pending answers for the person making the call, so each person sees their own): "Signed in on <device name>" with the time, a main
 * button that signs that device out and one that says it was them. The title is the device's own label, cut and never empty. Only a well-formed device id makes a card.
 * @param {any} answer identity.signins.pending's answer @returns {SignInCard[]}
 */
export function deviceCards(answer) {
  const list = Array.isArray(answer?.devices) ? answer.devices : [];
  return list.filter((/** @type {any} */ d) => d && DEVICE_ID.test(String(d.device)))
    .map((/** @type {any} */ d) => {
      const device = String(d.device), label = typeof d.label === "string" ? d.label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      return { id: `signins:${device}`, title: `Signed in on ${label || "a new device"}`, detail: "", at: Number(d.at) || 0,
        buttons: [{ label: "Not me, sign it out", tool: DEVICE_CALLS.revoke, input: { device } }, { label: "It was me", tool: DEVICE_CALLS.ack, input: { device } }] };
    }).sort((/** @type {SignInCard} */ a, /** @type {SignInCard} */ b) => a.at - b.at);
}
