// @ts-check
// cards: the words of every Wink card and removal prompt, exactly as in team/0.3/wink-copy.md (app-design's Annex A to the Wink network
// spec, section 6) and the spaces prototype. Nothing here is composed from user input without a name or a fingerprint, and no string
// ever contains the words the copy rules forbid on screen (network, node, tailnet, VPN, relay, route, key, token, address, ticket,
// locator, SPAKE, handshake, vyred, box). A card says four things (who, where it goes, what it allows, for how long) and has two
// buttons that name the action. A card for a kind Annex A does not word yet carries `open: true` and neutral words, so app-design can
// replace them without touching any logic.

/** Words that never appear on screen (wink-copy.md, rule 3). */
export const FORBIDDEN = /\b(network|node|tailnet|VPN|relay|route|key|token|address|ticket|locator|SPAKE|handshake|vyred|box)\b/i;

const clean = (/** @type {unknown} */ s, /** @type {string} */ d) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || d;

/**
 * @typedef {{ name?: string, fingerprint?: string, os?: string }} Party
 * @typedef {{ kind: "phone" | "computer" | "server" | "storage" | "share" | "invite" | "lend", receiver: Party, approver?: Party, space?: string,
 *   inviter?: Party, level?: number, server?: string, quota?: string, days?: number|null }} CardInput
 */

/**
 * @param {CardInput} i
 * @returns {{ kind: string, title: string, who: string, you?: string, goesInto: string, allows: string, forHowLong: string, from?: string,
 *   primary: string, secondary: string, sensitive: boolean, open?: true }}
 */
export function card(i) {
  const name = clean(i.receiver.name, "this device");
  const fp = clean(i.receiver.fingerprint, "");
  const who = fp ? `${name}, ${fp}` : name;
  const you = i.approver && i.approver.fingerprint ? `${clean(i.approver.name, "your device")}, ${clean(i.approver.fingerprint, "")}` : undefined;
  const space = clean(i.space, "Personal");
  const until = i.days ? `${i.days} days` : "Until you remove it";
  const out = (/** @type {object} */ c) => /** @type {any} */ ({ kind: i.kind, who, ...(you ? { you } : {}), forHowLong: until, sensitive: false, ...c });
  switch (i.kind) {
    case "phone":
      return out({ title: `Add this phone to ${space}?`, goesInto: `Goes into: ${space}`,
        allows: "It can open your projects and your vault, and use your computers.",
        primary: "Add with Face ID", secondary: "Not me", sensitive: true });
    case "computer": {
      const label = /mac/i.test(String(i.receiver.os)) ? "Mac" : /win|pc/i.test(String(i.receiver.os)) ? "PC" : "computer";
      return out({ title: `Add this ${label} to your server?`, goesInto: "Goes into: Personal",
        allows: "It can open your projects and your vault, and use your computers.", primary: "Add with Face ID", secondary: "Not me", sensitive: true });
    }
    case "storage":
      return out({ title: `Add ${name} to ${space}`, goesInto: `Goes into: ${space}`,
        allows: `${name} is a drive you own. It will hold files for you. It can: keep encrypted copies. It cannot: read them.`,
        primary: `Add ${name}`, secondary: "Cancel", sensitive: true });
    case "server":
      return out({ title: `Add ${name} to ${space}`, goesInto: `Goes into: ${space}`,
        allows: `${name} is a server ${space === "Personal" ? "you own" : `for ${space}`}. It will do heavy work${space === "Personal" ? " for you" : ""}. It can: run your sessions when you ask. It cannot: see your vault or your memory. It gets sealed logins per run.`,
        primary: `Add ${name}`, secondary: "Cancel", sensitive: true });
    case "invite":
      return out({ title: `Join ${space}`, from: clean(i.inviter && i.inviter.name, "someone") + (i.inviter && i.inviter.fingerprint ? `, ${clean(i.inviter.fingerprint, "")}` : ""),
        goesInto: `Goes into: ${space}`,
        allows: `${clean(i.inviter && i.inviter.name, "Someone")} invited you to work in ${space}'s space. ${space} will see: which of your devices touch its data. ${space} will not see: anything else on your devices, your Personal space or your other orgs.`,
        primary: `Join ${space}`, secondary: "Not now" });
    case "lend": {
      const server = clean(i.server, "a server");
      return out({ title: `${space} lends you ${server}`, goesInto: `Goes into: ${space}, for your sessions`,
        allows: `A shared server for heavy work. You get: ${clean(i.quota, "a share of its capacity")}. Ends: when you leave ${space}, or ${space} removes it.`,
        primary: `Use ${server}`, secondary: "Not now" });
    }
    case "share":
      // Annex A has no words for this card yet (a person lending their own computer to their own space): neutral words, marked open.
      return out({ open: true, title: "Share this computer with Personal?", goesInto: "Goes into: Personal",
        allows: "It can: run your sessions when it is awake and you have allowed it. It cannot: see your vault or your memory. You set how much of it Vyre may use.",
        primary: "Share this computer", secondary: "Not now", sensitive: true });
    default:
      throw Object.assign(new Error("no such card"), { code: "bad_input" });
  }
}

/** Plain-word lines for the pairing flows (DESIGN-wink section 4). Never a network, key or ticket word on screen. */
const WORDS = {
  chooseTarget: () => "Choose where to add it: you, or a space you administer.",
  phoneIdentityOnly: () => "A phone is added to you, not to a space. It reaches every space you belong to by itself.",
  computerIdentityOnly: () => "A computer is added to you, not to a space. It reaches every space you belong to by itself.",
  notAdmin: (/** @type {any} */ v) => `You are not an admin of ${clean(v && v.space, "that space")}, so you cannot add a server there.`,
  wrongCode: () => "That is not a Vyre code. Scan the code on the server's screen, or paste the long code it printed.",
  notACode: () => "That is not a Vyre code. Scan the code on the screen, or paste the long code it printed.",
  typedCodeOff: () => "That way of pairing is switched off in this release. Scan the code on the screen, or paste the long code it shows.",
  phoneAsk: (/** @type {any} */ v) => `Add ${clean(v && v.name, "this phone")} to your identity? Words: ${clean(v && v.words, "")}.`,
  phoneConfirm: (/** @type {any} */ v) => `Check the computer: it should show the words ${clean(v && v.words, "")}. Add the phone there only if they match. Good for 5 minutes.`,
  phoneRefused: () => "The phone was not added: it was turned down on the computer, or the pairing ended. Start again from Add a phone.",
  phoneExpired: () => "Nobody said yes on the computer in time, so nothing was added. Start again from Add a phone.",
  phoneWrongWords: () => "Those are not the words the phone shows, so nothing was added.",
  phoneMismatch: () => "The words the computer shows are not the ones here. Do not say yes. Nothing was added; start again from Add a phone.",
  phoneNotYours: () => "Only the phone that is asking can ask about its own pairing.",
  offline: () => "Wink could not reach the relay; try again in a minute. Nothing was lost.",
  relayOld: () => "The relay is out of date and refused this. It needs updating before pairing can work. Nothing was lost.",
  codeExpired: () => "That code ran out. Start again from the server.",
  alreadyPaired: (/** @type {any} */ v) => `${clean(v && v.name, "That server")} is already added. Run wink.remove for it first, then pair it again.`,
  serverOwned: (/** @type {any} */ v) => `This server already belongs to ${clean(v && v.owner, "someone")}. Remove it first: run wink.remove for it in the app, or change its owner on the server itself with wink.server.retarget, or free it there with wink.server.reset.`,
  stillOwned: (/** @type {any} */ v) => { const who = clean(v && v.owner, ""); return `This server still belongs to ${who || "someone"}. Remove it from ${who || "that app"} first, or reset it on the server itself (wink.server.reset).`; },
  releaseDenied: (/** @type {any} */ v) => `Only the app that owns this server can let it go, and this is not that app. It belongs to ${clean(v && v.owner, "someone")}. Remove it there, or reset it on the server itself (wink.server.reset).`,
  resetOnServer: () => "A server is reset from the server itself, not from another device. Run wink.server.reset on the server.",
  resetFingerprint: () => "That is not this server's fingerprint. Run vyre wink reset again and type the one it shows.",
  resetNeedsYou: () => "Resetting a server needs you at the server: confirm it there, or on a server with no passkey run vyre wink reset.",
  codeMatched: () => "The code matched. The app is finishing the pairing and will say whether it worked.",
  relayNoCode: () => "The relay gave no code: it is out of reach or busy. Nothing was lost; try again in a minute.",
  adoptFailed: (/** @type {any} */ v) => `${clean(v && v.name, "The server")} paired, but it could not be told who owns it (${clean(v && v.why, "no answer")}). Run wink.remove for it, then pair it again.`,
  busy: () => "Too many tries just now. Wait a minute and try again.",
  pairConfirm: (/** @type {any} */ v) => `Check the server: it should show the words ${clean(v && v.words, "")}. Say yes there only if they match. Good for 5 minutes.`,
  pairAsk: (/** @type {any} */ v) => `Pair this server to ${clean(v && v.name, "someone")}? Words: ${clean(v && v.words, "")}.`,
  pairBusy: () => "Another device is already asking to pair this server. Wait for it to finish, or start again from the server.",
  pairWrongIdentity: (/** @type {any} */ v) => `This server is waiting to pair to ${clean(v && v.name, "someone else")}, and this was not them, so nothing was paired.`,
  pairRefused: () => "The person at the server said no, so nothing was paired.",
  pairExpired: () => "Nobody said yes at the server in time, so nothing was paired. Start again from the server.",
  pairMismatch: () => "The words the server shows are not the ones here. Do not say yes. Nothing was paired; start again from the server.",
  kindCannotOffer: (/** @type {any} */ v) => `${v && v.kind === "phone" ? "A phone" : v && v.kind === "storage" ? "A storage device" : `A ${clean(v && v.kind, "device")}`} cannot offer ${clean(v && v.offer, "that")}.`,
  onlyComputeToSpace: () => "Only a computer can lend its compute to a space.",
  notYourDevice: () => "That device is not yours.",
};
/** @param {keyof typeof WORDS} key @param {any} [vars] */
export const words = (key, vars) => WORDS[key](vars);

/**
 * The confirm prompts for removal (wink-copy.md, section 7). The prompt always says what happens.
 * @param {{ what: "device" | "member" | "leave" | "lent" | "share", name?: string, space?: string, member?: string, count?: number }} i
 * @returns {{ prompt: string, primary: string, secondary: string, hold: boolean, count: number }}
 */
export function removal(i) {
  const name = clean(i.name, "this device"), space = clean(i.space, "your space");
  const count = Math.max(0, Math.floor(i.count || 0));
  switch (i.what) {
    case "device":
      return { prompt: `Remove ${name}? It will stop reaching your server at once and its saved data on the device is wiped when it next connects. It cannot take back what it has already opened or copied.`, primary: "Remove", secondary: "Cancel", hold: true, count };
    case "member":
      return { prompt: `Remove ${clean(i.member, "this person")} from ${space}? ${clean(i.member, "They")} loses ${space}'s projects and servers at once. They keep their own notes and files.`, primary: `Remove ${clean(i.member, "this person")}`, secondary: "Cancel", hold: true, count };
    case "leave":
      return { prompt: `Leave ${space}? You keep your private notes and your own copies. You lose ${space}'s projects and servers at once.`, primary: `Leave ${space}`, secondary: "Cancel", hold: true, count };
    case "lent":
      return { prompt: `Stop lending ${name} to ${clean(i.member, "this person")}? Sessions running there end.`, primary: "Stop lending", secondary: "Cancel", hold: true, count };
    case "share":
      return { prompt: `Stop sharing ${name}? Sessions running on it end, and what it stored for you is deleted when it next connects. It cannot take back what it has already opened or copied.`, primary: "Stop sharing", secondary: "Cancel", hold: true, count };
    default:
      throw Object.assign(new Error("no such prompt"), { code: "bad_input" });
  }
}

/** The result lines after a removal. @param {{ what: string, name?: string, space?: string, member?: string, release?: string }} i */
export function removed(i) {
  const name = clean(i.name, "this device");
  if (i.what === "member") return `${clean(i.member, "This person")} is no longer in ${clean(i.space, "your space")}.`;
  if (i.what === "leave") return `You left ${clean(i.space, "your space")}.`;
  if (i.release === "released") return `Removed ${name}. It let go of its owner and can be added again.`;
  if (i.release === "pending") return `Removed ${name}. It could not be reached, so it will be told to let go the next time it connects. To add it again at once, run wink.server.reset on the server.`;
  if (i.release === "gaveup") return `Removed ${name}. The server never confirmed that it let go, so Vyre stopped asking after 30 days. To add it again, run wink.server.reset on the server.`;
  if (i.release === "refused" || i.release === "unknown") return `Removed ${name}. It could not be told to let go. To add it again, run wink.server.reset on the server.`;
  return `Removed ${name}.`;
}
