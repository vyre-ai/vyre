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
 * @typedef {{ kind: "phone" | "computer" | "server" | "share" | "invite" | "lend", receiver: Party, approver?: Party, space?: string,
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
      return out({ title: "Add this phone to Personal?", goesInto: "Goes into: Personal",
        allows: "It can open your projects and your vault, and use your computers.",
        primary: "Add with Face ID", secondary: "Not me", sensitive: true });
    case "computer": {
      const label = /mac/i.test(String(i.receiver.os)) ? "Mac" : /win|pc/i.test(String(i.receiver.os)) ? "PC" : "computer";
      return out({ title: `Add this ${label} to your server?`, goesInto: "Goes into: Personal",
        allows: "It can open your projects and your vault, and use your computers.", primary: "Add with Face ID", secondary: "Not me", sensitive: true });
    }
    case "server":
      return out({ title: `Add ${name} to Personal`, goesInto: "Goes into: Personal",
        allows: `${name} is a server you own. It will do heavy work for you. It can: run your sessions when you ask. It cannot: see your vault or your memory. It gets sealed logins per run.`,
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

/** The result lines after a removal. @param {{ what: string, name?: string, space?: string, member?: string }} i */
export function removed(i) {
  const name = clean(i.name, "this device");
  if (i.what === "member") return `${clean(i.member, "This person")} is no longer in ${clean(i.space, "your space")}.`;
  if (i.what === "leave") return `You left ${clean(i.space, "your space")}.`;
  return `Removed ${name}.`;
}
