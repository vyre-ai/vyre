import { callT as call } from "../../src/real/call-tool";
import { settingsSource } from "./real-source";
import { getHost, hostWanted } from "../../src/host";
import type { Entry, Identity } from "./account-model";
import { publicEntries } from "../../src/identity/public-list.js";

const source = settingsSource(call);
export const { updateStatus, updateCheck, updateApply, pushSettings, pushSet, pushDevices, agentsList, agentsUsage, agentStop, agentResume, agentDelete, providers, types } = source;

// A page with no daemon (the Mac window with no vyred, the hosted web app) keeps the person's name in its own host, and its server's box holds none ("No Vyre name on this device yet"): the name and the list of
// devices are read there and from the names directory, not from the box.
const directoryBase = (): string => ((typeof process !== "undefined" ? process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || process.env.EXPO_PUBLIC_VYRE_NAMES : "") || "https://names.vyre.run").replace(/\/+$/, "");

/** The person this server knows by name (onboard.status), for a page that holds no key of its own: a browser or phone on the server's address. Null when it knows no one. */
async function personOfServer(): Promise<{ username: string; label: string } | null> {
  const r = await call<{ person?: string | null; accountName?: string | null }>("onboard.status", {});
  const username = typeof r.data?.person === "string" ? r.data.person : "";
  return username ? { username, label: typeof r.data?.accountName === "string" && r.data.accountName ? r.data.accountName : username } : null;
}

export const identity = async (): Promise<Identity> => {
  if (hostWanted()) {
    const s = (await getHost().call("identity.status")) as { exists?: boolean; username?: string | null; id?: string | null };
    return s.exists ? { exists: true, name: s.username ?? undefined, id: s.id ?? undefined } : { exists: false };
  }
  const own = await source.identity();
  if (own.exists) return own;
  // The server holds no identity (the keys are on the person's Mac or phone): say who the server knows, read-only.
  const who = await personOfServer().catch(() => null);
  return who ? { exists: true, name: who.username, label: who.label, readOnly: true } : own;
};
export const entries = async (): Promise<Entry[]> => {
  if (hostWanted()) return ((await getHost().call("identity.entries")) as { entries?: Entry[] }).entries ?? [];
  const own = await source.identity();
  if (own.exists) return source.entries();
  const who = await personOfServer().catch(() => null);
  if (!who) return [];
  const r = await call<{ id?: string }>("spaces.identity.resolve", { name: who.username });
  if (!r.data?.id) return [];
  return publicEntries({ directory: directoryBase(), id: r.data.id });
};

/** A new recovery code: on a page with no daemon the host makes it (it needs the person's password); otherwise the box does. A page that only reads the list (no key here) does not offer it. */
export const replaceCode = async (password?: string): Promise<unknown> => (hostWanted() ? getHost().call("identity.code.replace", { password: password ?? "" }) : source.replaceCode(password));
/** Take a device off the list. */
export const removeEntry = async (eid: string): Promise<unknown> => (hostWanted() ? getHost().call("identity.entry.remove", { eid }) : source.removeEntry(eid));
/** Does Account on this page need the person's password to make a new recovery code (the host signs it, the box is not asked)? */
export const needsPasswordForCode = (): boolean => hostWanted();

/** Why private chats could not be set up on this page (the unlock-time repair), or "" when nothing is wrong or this page has no host. */
export const chatSetupProblem = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.agree.status")) as { failed?: string }).failed ?? "" : "");
export const retryChatSetup = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.agree.retry")) as { failed?: string }).failed ?? "" : "");
