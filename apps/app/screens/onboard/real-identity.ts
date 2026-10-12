// The Identity screens' real calls, behind one small door each. In MOCK every call answers from flow-model.js, so the prototype behaves as before; otherwise it reaches the code that already exists:
// the names directory (src/real/install.ts), the new-device pairing (src/identity/add-device.ts) and the recovery code (src/identity/restore.ts). Each failure answers `{ say }`, a sentence and a next step,
// never the directory's own text. Nothing here is new server logic.

import { Platform } from "react-native";
import { MOCK } from "../../src/real/box";
import { claimBlocked } from "../shell/rc";
import { DEMO, SIGNIN_WORDS, knownName, nameStatus, recoveryStatus } from "./flow-model.js";
import { nameOf, recoverCheck, recoverRefusal } from "../install/have-model.js";

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; say: string };
const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** What this device is called to the other device that approves it. */
export const deviceLabel = (): string => (Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "phone" : "computer");

const NAME_RE = /^[a-z][a-z0-9-]{2,19}$/;
const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a name can be reserved: the form first (no call for an empty or badly formed name), then the directory's own answer. "unknown" is a directory that did not answer, never a guess. */
export async function nameState(raw: string): Promise<"empty" | "invalid" | "free" | "taken" | "unknown"> {
  if (MOCK) return nameStatus(raw) as "empty" | "invalid" | "free" | "taken";
  const n = nameOf(raw);
  if (!n) return "empty";
  if (!NAME_RE.test(n)) return "invalid";
  const { checkName } = await import("../../src/real/install");
  return checkName(n);
}

/** Does the directory hold a person by this name? Sign in asks this before it asks another device for anything. */
export async function nameExists(raw: string): Promise<Outcome<{ exists: boolean }>> {
  if (MOCK) return { ok: true, exists: knownName(raw) };
  const { DIRECTORY } = await import("../../src/real/install");
  try {
    const r = await fetch(`${DIRECTORY}/v1/ids/resolve?name=${encodeURIComponent(nameOf(raw))}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (r.status === 404) return { ok: true, exists: false };
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.error || !body.data) return r.ok || r.status < 500 ? { ok: true, exists: false } : { ok: false, say: recoverRefusal("unreachable") };
    return { ok: true, exists: body.data.kind === "person" };
  } catch { return { ok: false, say: recoverRefusal("unreachable") }; }
}

const claimSay = (c: string | undefined): string => {
  if (c === "taken" || c === "name_taken") return "That name was taken a moment ago. Go back and pick another.";
  if (c === "reserved" || c === "invalid") return "Vyre cannot use that name. Go back and pick another.";
  if (c === "unreachable") return "Vyre cannot reach the names directory right now. Nothing was claimed. Try again in a minute.";
  if (c === "rate_limited") return "Too many names were reserved from here today. Try again tomorrow.";
  if (c === "bad_code") return "The reservation ran out before it finished. Nothing was claimed. Try again.";
  if (c === "cannot_keep") return "This device would not keep your key, so no name was claimed. Try again, or use another browser.";
  if (c === "no_biometrics") return Platform.OS === "ios" ? "Set up Face ID or Touch ID on this iPhone, then try again. No name was claimed." : "Set up a screen lock and a fingerprint or face on this phone, then try again. No name was claimed.";
  return "No name was claimed. Try again.";
};

/** Reserve the name at the directory (24 hours, one code), as vyre.run/setup does. The code goes straight to the claim and is never shown. */
async function reserve(name: string): Promise<string> {
  const { DIRECTORY } = await import("../../src/real/install");
  let r: Response;
  try { r = await fetch(`${DIRECTORY}/v1/ids/reserve`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name }) }); }
  catch { throw Object.assign(new Error("unreachable"), { code: "unreachable" }); }
  const body = await r.json().catch(() => null);
  if (r.ok && body?.data?.code) return String(body.data.code);
  throw Object.assign(new Error("refused"), { code: r.status === 429 ? "rate_limited" : body?.error?.code ?? "unreachable" });
}

/**
 * Make a new name on this device: reserve it, make this device's key, claim. The recovery code comes back in this answer only: the screen shows it once and drops it.
 * A browser never makes a name (claimBlocked); it says so before anything is asked.
 */
export async function claimNewName(raw: string): Promise<Outcome<{ name: string; recoveryCode: string }>> {
  if (MOCK) { await slow(600); return { ok: true, name: nameOf(raw), recoveryCode: DEMO.recoveryCode }; }
  if (claimBlocked()) return { ok: false, say: "Create your name on your iPhone, then sign in here. A browser cannot make one." };
  try {
    const name = nameOf(raw);
    const held = await reserve(name);
    const { createIdentity } = await import("../../src/real/install");
    const made = await createIdentity(held, deviceLabel());
    return { ok: true, name: made.name, recoveryCode: made.recoveryCode };
  } catch (e) { return { ok: false, say: claimSay(code(e)) }; }
}

/**
 * Sign in on a new device with what the existing add-a-device pairing already does: the other device (Devices, Add a device) shows a code; this device types it, shows the three words, and
 * the other device says yes. `onWords` gets the three words, `onAck` the code to type back there. Resolves the name this device now holds.
 */
export async function signInWithCode(o: { code: string; onWords: (w: string[]) => void; onAck: (c: string) => void; signal?: AbortSignal }): Promise<Outcome<{ name: string }>> {
  if (MOCK) { o.onWords(SIGNIN_WORDS); await slow(900); return { ok: true, name: "alex" }; }
  try {
    const { addDeviceToName, addSay } = await import("../../src/identity/add-device");
    const text = o.code.trim();
    const typed = /^wink-/i.test(text);
    try {
      const r = await addDeviceToName({ ...(typed ? { code: text.toUpperCase() } : { payload: text }), deviceLabel: deviceLabel(), onWords: (w) => o.onWords(w.split(/\s+/).filter(Boolean)), onAck: o.onAck, ...(o.signal ? { signal: o.signal } : {}) });
      return { ok: true, name: r.name };
    } catch (e) { return { ok: false, say: addSay(code(e)) }; }
  } catch { return { ok: false, say: "Vyre could not start adding this device. Nothing was added. Try again." }; }
}

/** Sign in with the recovery code from the kit: the form is checked first, then the existing recovery (restore.ts), which puts this device's key on the name's list. */
export async function recoverWithKit(raw: { name: string; code: string }): Promise<Outcome<{ name: string }>> {
  if (MOCK) { await slow(500); return recoveryStatus(raw.code) === "ok" ? { ok: true, name: nameOf(raw.name) || "alex" } : { ok: false, say: "That is not the recovery code for this name. Check the page you saved, or ask another device to approve you instead." }; }
  const bad = recoverCheck({ name: raw.name, code: raw.code });
  if (bad) return { ok: false, say: bad.say };
  try {
    const [{ recoverIdentity }, { recoveryKeyOptions }] = await Promise.all([import("../../src/identity/restore"), import("../../src/keys")]);
    const k = await recoveryKeyOptions();
    const r = await recoverIdentity({ name: nameOf(raw.name), code: raw.code, deviceLabel: deviceLabel(), ...k });
    return { ok: true, name: r.name };
  } catch (e) { return { ok: false, say: recoverRefusal(code(e)) }; }
}

/** The recovery kit page: one line of text with the code, as a file a person can keep. Only the identity's recovery code is in it. */
export const kitText = (name: string, recoveryCode: string): string =>
  `Vyre recovery kit\nName: ${name}.vyre.run\nRecovery code: ${recoveryCode}\n\nKeep this page somewhere safe. The code lets you sign in as ${name} if you lose every device. Vyre cannot send you another copy.\n`;

// The recovery code lives here, between the claim and the kit page, and nowhere else: not in the flow's state, not stored. It is dropped when the person leaves the kit page.
let held: { name: string; code: string } | null = null;
export const holdKit = (name: string, recoveryCode: string): void => { held = { name, code: recoveryCode }; };
export const readKit = (): { name: string; code: string } | null => (MOCK ? { name: "alex", code: DEMO.recoveryCode } : held);
export const dropKit = (): void => { held = null; };

/** Save the kit page as a file (a browser downloads it) or hand it to the share sheet (a phone). Resolves whether the person got it. */
export async function saveKit(text: string, how: "file" | "print"): Promise<boolean> {
  try {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      if (how === "print") {
        const w = window.open("", "_blank");
        if (!w) return false;
        w.document.title = "Vyre recovery kit";
        const pre = w.document.createElement("pre");
        pre.textContent = text;
        w.document.body.appendChild(pre);
        w.focus(); w.print();
        return true;
      }
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url; a.download = "vyre-recovery-kit.txt";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
    const { Share } = await import("react-native");
    const r = await Share.share({ message: text });
    return r.action !== Share.dismissedAction;
  } catch { return false; }
}
