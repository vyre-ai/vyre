// The install flow's calls to the box (screens/install/real.js maps the answers). Each is one tool through src/real/box.ts.

import { said, tool } from "./box";
import { Platform } from "react-native";
import { RC, claimBlocked } from "../../screens/shell/rc";
import { macDeviceKey, macEnclavePublic, macKeyAvailable, shellKeyHeld } from "../identity/mac-key.ts";
import { agreePublic } from "../identity/agree.ts";
import { enclavePublic } from "../keys";
import { claimIdentity, claimIdentityWithPasskey } from "../identity/claim.js";
import { forgetIdentity, loadIdentity, saveIdentity } from "../identity/store";
import { createdFrom, identityFrom, nameAnswerChecked } from "../../screens/install/real.js";

type Created = { state: "done" | "running" | "asking" | "failed"; id: string; address: string; say: string };

/** This device's claimed name, or null. */
export const readIdentity = async (): Promise<{ id: string; label: string; address: string } | null> => {
  // The identity this device made comes first (it needs no box); a paired box's own answer is the fallback, and no box is not an error here.
  // A blocked browser (RC1) ignores a key an earlier build left in IndexedDB: that key was never meant to be used here, and the person pairs instead.
  const mine = claimBlocked() ? null : await loadIdentity();
  if (mine) return { id: mine.id, label: mine.name, address: `${mine.name}.vyre.run` };
  try { return identityFrom(await tool("spaces.identity.status")); } catch { return null; }
};

/**
 * Where the names directory is: the public service, never a box. The identity comes first (a name, then a space, then a server), so
 * a name is checked before there is any box to ask. EXPO_PUBLIC_VYRE_NAMES_DIRECTORY points a walk at a stand-in (read as process.env.NAME exactly: Expo inlines only that form, so an optional chain left the override out of the web build).
 */
export const DIRECTORY: string = ((typeof process !== "undefined" && process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY) || "https://names.vyre.run").replace(/\/+$/, "");

/** Is a name free in the directory? Asked of the directory itself, no box: /v1/names/check covers people, spaces and anything else that holds a name, in the one namespace. An answer that is neither free nor taken is "unknown". */
export async function checkName(name: string): Promise<"free" | "taken" | "unknown"> {
  try {
    const r = await fetch(`${DIRECTORY}/v1/names/check?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    const body = await r.json().catch(() => null);
    return nameAnswerChecked(r.status, body);
  } catch {
    // A browser cannot read an answer from a directory that sends no CORS headers: that is also "unknown", never a guess.
    return "unknown";
  }
}

/** Which name a reservation code holds (the code is not spent). Throws with code bad_code for a wrong, used, replaced or lapsed code. */
export async function reservedName(code: string): Promise<string> {
  let r: Response;
  try { r = await fetch(`${DIRECTORY}/v1/ids/reserved-for`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ code }) }); }
  catch { throw Object.assign(new Error("Cannot reach the names directory right now."), { code: "unreachable" }); }
  const body = await r.json().catch(() => null);
  if (r.ok && body?.data?.name) return String(body.data.name);
  if (body?.error?.code === "bad_code") throw Object.assign(new Error("That reservation code is not valid. It lasts 24 hours and works once, and reserving the name again replaces it. Reserve the name again at vyre.run/setup."), { code: "bad_code" });
  throw Object.assign(new Error(r.status === 429 ? "Too many tries from here. Wait a little." : "Cannot check this code right now. Try again."), { code: body?.error?.code ?? "directory" });
}

/**
 * Claim the person's name from this device, with no box: the key is made here, the claim goes to the names directory, and the identity is kept
 * here. The recovery code is in this answer only: the caller shows it once and drops it.
 */
export async function createIdentity(code: string, deviceLabel: string, password = ""): Promise<{ name: string; id: string; recoveryCode: string; software: boolean }> {
  // RC1: a browser never makes a name (KP-1): refused before any key is made, any storage is opened or the directory is asked.
  if (claimBlocked()) throw new Error("Create your name on your iPhone, then pair this browser to it.");
  // The code says which name it holds; nothing is spent until the claim goes through.
  const name = await reservedName(code);
  // Save first, then claim: the key is kept and read back BEFORE the name is claimed, so a failed save claims nothing and never loses the recovery code.
  let kept = false;
  // On an iPhone the device entry also names the Secure Enclave key (NK-2): every later change to who speaks for this name needs that key's Face ID signature too. No Face ID, no name.
  let enclave: string | undefined;
  // On Android the same field names the Keystore key (StrongBox or the TEE, fingerprint or face per use), unattested in RC1.
  if (Platform.OS === "ios" || Platform.OS === "android") {
    try { enclave = await enclavePublic(); } catch { throw Object.assign(new Error(Platform.OS === "ios" ? "Set up Face ID or Touch ID on this iPhone, then create your name." : "Set up a screen lock and a fingerprint or face on this phone, then create your name."), { code: "no_biometrics" }); }
  }
  // The Mac app's window signs with the key in the Mac's Keychain (the seed never reaches this page).
  const macKey = macKeyAvailable() ? await macDeviceKey(true) : null;
  if (macKeyAvailable() && !macKey) throw Object.assign(new Error("This computer would not keep your key, so no name was claimed."), { code: "cannot_keep" });
  // A browser build that may claim (EXPO_PUBLIC_VYRE_BROWSER_CLAIM) makes the name with a passkey: a full device the person unlocks, never a key a script on the page could use.
  // The Mac and Windows apps' windows are web pages too, but they hold their own key: they claim with it, never with a browser passkey (IR-32).
  const claim = !macKey && Platform.OS === "web" && RC.browserClaim ? claimIdentityWithPasskey : claimIdentity;
  if (macKeyAvailable()) enclave = (await macEnclavePublic(true)) ?? undefined; // none on a Mac with no Secure Enclave: its entry signs alone
  // This device's agreement key (its public point goes in the entry as `agree`): none in a plain browser.
  const agreeKey = (await agreePublic(true)) ?? undefined;
  try {
    const made = await claim({
      name, code, password, deviceLabel, base: DIRECTORY, ...(enclave ? { enclave } : {}), ...(macKey ? { key: macKey } : {}), ...(agreeKey ? { agree: agreeKey } : {}), ...((await shellKeyHeld()) ? { held: true } : {}),
      beforeClaim: async (m) => {
        await saveIdentity({ name: m.name, id: m.id, eid: m.eid, ops: m.ops, pin: m.pin, key: m.key });
        const back = await loadIdentity();
        if (!back || back.eid !== m.eid) throw Object.assign(new Error("This browser would not keep your key, so no name was claimed. Try another browser or a private window turned off."), { code: "cannot_keep" });
        kept = true;
      },
    });
    return { name: made.name, id: made.id, recoveryCode: made.recoveryCode, software: made.software };
  } catch (e) {
    // The claim itself failed after the key was kept: take the key back out so no identity is left that names nothing.
    // (An unreachable directory is ambiguous: the claim may have landed, so the key stays.)
    if (kept && (e as { code?: string })?.code !== "unreachable") await forgetIdentity().catch(() => {});
    throw e;
  }
}

export async function createSpace(input: Record<string, unknown>): Promise<Created> {
  return createdFrom(await tool("spaces.create", input));
}
export async function resumeSpace(space: string): Promise<Created> {
  return createdFrom(await tool("spaces.resume", { space }));
}

export const listSpaces = () => tool<any[]>("spaces.list");
export const saveSetup = (space: string, setup: Record<string, unknown> | null) => tool("spaces.setup.save", { space, setup });
export const claimSetup = (space: string) => tool<{ space: string; setup: any; moved?: boolean }>("spaces.setup.claim", { space });
// A device that keeps the person's name itself (this app, with or without a server) joins from here: its name's key is in this app, and a server holds no identity to accept for it (join-team.ts).
export const previewInvite = async (link: string) => { const t = await import("./team-join"); return (await t.holdsName()) ? t.previewTeamInvite(link) : tool<any>("spaces.invites.preview", { link }); };
export const acceptInvite = async (link: string) => { const t = await import("./team-join"); return (await t.holdsName()) ? t.acceptTeamInvite(link) : tool<any>("spaces.invites.accept", { link }); };

/** The Kits the box offers a new space (flows.kit.library). null when the box has no such tool: the step then offers none. */
export async function kitChoices(): Promise<{ id: string; label: string; sub: string }[] | null> {
  try {
    const r = await tool<any>("records.kits.library").catch(() => tool<any>("flows.kit.library"));
    const rows: any[] = Array.isArray(r) ? r : Array.isArray(r?.kits) ? r.kits : [];
    return rows.map((k) => ({ id: String(k.id), label: String(k.name ?? k.id), sub: String(k.description ?? "") }));
  } catch { return null; }
}

/** Ask to install the picked Kit in the new space. It lands as a card in Now for a person to approve; nothing installs until then. */
export async function proposeKitFor(space: string, id: string): Promise<{ ok: boolean; text: string }> {
  try {
    const got = await tool<any>("records.kits.get", { id }).catch(() => tool<any>("flows.kit.library.get", { id }));
    const kit = got && typeof got === "object" && got.kit ? got.kit : got;
    const r = await tool<any>("flows.kit.propose", { space, kit });
    return r?.ok === false ? { ok: false, text: r.errors?.[0]?.message ?? "The Kit cannot be installed." } : { ok: true, text: "waiting" };
  } catch (e) { return { ok: false, text: said(e) }; }
}

/**
 * Make the space on the server this device is paired to (claimServerSpace through chat's hooks), keep its root public key beside it, and answer the id.
 * Refusals keep their codes: store_unavailable (the server cannot run the record store, Twenty; its plain words are shown), server_too_old, on_phone (a browser), the directory's own.
 */
export async function makeServerSpace(slug: string, displayName: string): Promise<string> {
  const { makeSpaceOnPairedServer } = await import("./claim-space");
  const { keepRootPublic } = await import("../state/space-roots");
  const made = await makeSpaceOnPairedServer({ name: slug, displayName });
  await keepRootPublic(made.space, made.rootPublic);
  return made.space;
}

