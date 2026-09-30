// @ts-check
// floor: where Vyre's eyes and hands on the Mac stop, whatever a model asks (SPEC section 11).
//
// Screen context and computer use see and drive the user's own Mac, and the Mac is where the
// floor's human-only actions happen: the Capsule approves a held send, the Deck reveals a vault
// value after a presence proof, macOS asks for Touch ID. A model that can read those screens or
// press those buttons has walked around the floor without calling a single human-only tool. So
// the list lives here, in one place, and both the screen module and the hands module read it.
//
//   blind    screen context names the app and window and returns no text from it
//   hands    computer use refuses to act there at all
//   outward  an act that sends something as the user, which needs a person (hands.commit)
//
// Matching is by bundle id first, because a window title is whatever the app says it is.

/** Vyre's own surfaces: the Capsule, the side view, the launcher, anything we ship. */
const VYRE = /^run\.vyre(\.|$)/i;

/** macOS asking a person to prove who they are, or to grant something. */
export const SYSTEM_AUTH = new Set([
  "com.apple.SecurityAgent",
  "com.apple.LocalAuthentication.UIAgent",
  "com.apple.CoreAuthentication.UIAgent",
  "com.apple.coreautha",
  "com.apple.UserNotificationCenter",
  "com.apple.security.pboxd",
  "com.apple.TCC",
]);

/** Apps whose whole job is holding secrets. */
export const SECRETS = new Set([
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.agilebits.onepassword-osx",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.dashlane.dashlanephonefinal",
  "org.keepassxc.keepassxc",
]);

/** System Settings panes where a click grants a permission or changes who can sign in. */
const SETTINGS = "com.apple.systempreferences";
const GUARDED_PANES = /privacy|security|passwords|touch id|login password|users & groups|lock screen|login items|profiles|internet accounts|wallet/i;

/** Apps where Return in a message field sends the message. */
export const MESSAGING = new Set([
  "com.apple.MobileSMS", "com.apple.mail", "com.tinyspeck.slackmacgap", "com.microsoft.Outlook",
  "com.microsoft.teams", "com.microsoft.teams2", "net.whatsapp.WhatsApp", "ru.keepcoder.Telegram",
  "com.hnc.Discord", "org.whispersystems.signal-desktop", "com.facebook.archon", "us.zoom.xos",
]);

/**
 * Browsers: Return in a text field here can submit an ordinary web form (a checkout, a comment
 * box, a bank transfer), and the page's own submit button is a control Vyre has no AX-level way
 * to mark "default" (that needs the DOM, which is capsule-sight's deep-Chrome-control work, not
 * this AX-only floor). Held on the safe side until that lands.
 */
export const BROWSERS = new Set([
  "com.apple.Safari", "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
  "com.google.Chrome.canary", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser",
  "company.thebrowser.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
]);
/** Text-entry roles: a Return in one of these, in a browser, can submit a form. */
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);

/**
 * Words on a control that mean pressing it sends, posts or pays as the user (reviewer-2 B1,
 * 30 Sep): matched as a substring, case-insensitively, so real checkout and composer labels
 * ("Place your order", "Pay $40.00", "Continue to payment", "Confirm and pay", "Post comment")
 * are caught, not just an exact "Send"/"Pay". Anchored words stay too, so a label that IS one of
 * these words and nothing else still matches with no substring false-positive risk either way.
 * English first; other charter-market languages follow the same shape.
 */
const OUTWARD_WORDS_EN = [
  "send", "reply", "reply all", "forward", "post", "publish", "tweet", "share", "submit",
  "pay", "place your order", "place order", "buy", "purchase", "checkout", "continue to payment",
  "confirm and pay", "confirm payment", "confirm purchase", "confirm order", "transfer",
  "delete account", "approve", "sign", "merge pull request", "donate", "subscribe", "tip",
];
/** German, Spanish, French, Portuguese equivalents of the same list, for the same reason. */
const OUTWARD_WORDS_INTL = [
  // de
  "senden", "antworten", "weiterleiten", "veröffentlichen", "teilen", "absenden", "bezahlen",
  "kaufen", "bestellen", "jetzt kaufen", "weiter zur zahlung", "zahlung bestätigen", "überweisen",
  // es
  "enviar", "responder", "reenviar", "publicar", "compartir", "pagar", "comprar", "confirmar pago",
  "confirmar compra", "realizar pedido", "transferir",
  // fr
  "envoyer", "répondre", "transférer", "publier", "partager", "payer", "acheter",
  "confirmer et payer", "confirmer la commande", "passer la commande", "virer",
  // pt
  "enviar", "responder", "reenviar", "publicar", "compartilhar", "pagar", "comprar",
  "confirmar pagamento", "confirmar pedido", "finalizar compra", "transferir",
];
const OUTWARD_WORDS = [...OUTWARD_WORDS_EN, ...OUTWARD_WORDS_INTL];
/** A label that is exactly one of the short words above (old anchored behaviour, kept for parity). */
const OUTWARD_NAMES = /^(send( now| message| email)?|reply( all)?|forward|post|publish|tweet|share|submit|pay( now)?|buy( now)?|place order|purchase|confirm (payment|purchase|order)|transfer|delete account|approve|sign|merge( pull request)?)$/i;

/** Whether a control's own label (or its AX identifier) reads as an outward action. */
function namesOutward(/** @type {string} */ name, /** @type {string} */ identifier = "") {
  const n = name.trim().toLowerCase();
  const d = String(identifier || "").trim().toLowerCase();
  if (!n && !d) return false;
  if (OUTWARD_NAMES.test(name.trim())) return true;
  return OUTWARD_WORDS.some(w => n.includes(w) || d.includes(w));
}

/**
 * @typedef {{ bundle?: string|null, app?: string|null, window?: string|null, url?: string|null }} Where
 * @typedef {{ box?: string|null }} Known   the paired box's https origin, when there is one
 */

const origin = (/** @type {string|null|undefined} */ u) => { try { return u ? new URL(u).origin : null; } catch { return null; } };

/**
 * Why this place is off limits to the eyes, or null. Blind means screen context gives the app
 * and the window title and nothing more: no focused value, no selection, no visible text.
 * @param {Where} w @param {Known} [k] @returns {string|null}
 */
export function blind(w, k = {}) {
  const b = w.bundle || "";
  if (VYRE.test(b)) return "a Vyre surface";
  if (SYSTEM_AUTH.has(b)) return "a system sign-in or permission dialog";
  if (SECRETS.has(b)) return "a password manager";
  if (b === SETTINGS && GUARDED_PANES.test(w.window || "")) return "a security pane of System Settings";
  // The Deck and Glass are Vyre surfaces too, served from the box into an ordinary browser: a
  // revealed vault value or a held approval there is as off limits as it is in the Capsule.
  if (k.box && w.url && origin(w.url) === origin(k.box)) return "a Vyre surface in the browser";
  return null;
}

/**
 * Why computer use may not act here, or null. Everywhere blind is also out of reach of the
 * hands: an agent must never press the button that approves its own request.
 * @param {Where} w @param {Known} [k] @returns {string|null}
 */
export function untouchable(w, k = {}) {
  return blind(w, k);
}

/**
 * Whether one act sends something out as the user (floor rule 1), and why. Such an act is not
 * refused, it is held for a person to see and approve at the Gate (reviewer-2 H1: the card shows
 * the real snapshot, not just this reason string).
 * @param {Where} w
 * @param {{ kind: string, name?: string|null, role?: string|null, identifier?: string|null, key?: string|null, modifiers?: string[]|null, value?: string|null }} act
 * @returns {string|null}
 */
export function outward(w, act) {
  const name = String(act.name || "").trim();
  const id = String(act.identifier || "").trim();
  if (act.kind === "press" && namesOutward(name, id)) return `pressing "${name || id}" sends something as you`;
  const mods = (act.modifiers || []).map(m => m.toLowerCase());
  const isReturn = act.kind === "key" && /^(return|enter)$/i.test(act.key || "");
  const shifted = mods.includes("shift");
  // Command-Return sends in Mail, Gmail, Outlook and most composers.
  if (isReturn && (mods.includes("cmd") || mods.includes("command"))) return "Command-Return sends the message";
  if (MESSAGING.has(w.bundle || "")) {
    if (isReturn && !shifted) return `Return sends the message in ${w.app || "this app"}`;
    if (act.kind === "type" && /[\r\n]/.test(act.value || "")) return `a line break sends the message in ${w.app || "this app"}`;
  }
  // Return in a text field of a browser can submit an ordinary web form (a checkout, a comment
  // box, a payment); held on the safe side until deep Chrome control can see the real DOM and
  // tell a submit from a plain newline (reviewer-2 B1).
  if (BROWSERS.has(w.bundle || "") && isReturn && !shifted && TEXT_ROLES.has(String(act.role || ""))) {
    return `Return can submit a form in ${w.app || "this browser"}`;
  }
  return null;
}
