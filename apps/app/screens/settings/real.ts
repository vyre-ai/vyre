import { callT as call } from "../../src/real/call-tool";
import { settingsSource } from "./real-source";
import { getHost, hostWanted } from "../../src/host";
import type { Entry, Identity } from "./account-model";
import { publicEntries } from "../../src/identity/public-list.js";
import { readOnlyEntries, readOnlyIdentity } from "./account-read.js";

const source = settingsSource(call);
export const { updateStatus, updateCheck, updateApply, pushSettings, pushSet, pushDevices, agentsList, agentsUsage, agentStop, agentResume, agentDelete, providers, types } = source;

// A page with no daemon (the Mac window with no vyred, the hosted web app) keeps the person's name in its own host, and its server's box holds none ("No Vyre name on this device yet"): the name and the list of
// devices are read there and from the names directory, not from the box.
const directoryBase = (): string => ((typeof process !== "undefined" ? process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || process.env.EXPO_PUBLIC_VYRE_NAMES : "") || "https://names.vyre.run").replace(/\/+$/, "");

// A page with a daemon but no key of the person's own (a browser or phone on a server's address): the box holds no identity either, so the page says the person the server knows and reads their list from the
// directory, read-only (account-read.js).
export const identity = async (): Promise<Identity> => {
  if (!hostWanted()) {
    const own = await source.identity();
    return own.exists ? own : ((await readOnlyIdentity(call, own)) as Identity);
  }
  const s = (await getHost().call("identity.status")) as { exists?: boolean; username?: string | null; display?: string; id?: string | null };
  return s.exists ? { exists: true, name: s.username ?? undefined, ...(s.display ? { label: s.display } : {}), id: s.id ?? undefined } : { exists: false };
};
export const entries = async (): Promise<Entry[]> => {
  if (!hostWanted()) {
    const own = await source.identity();
    return own.exists ? source.entries() : ((await readOnlyEntries(call, (id) => publicEntries({ directory: directoryBase(), id }))) as Entry[]);
  }
  return ((await getHost().call("identity.entries")) as { entries?: Entry[] }).entries ?? [];
};

/** A new recovery code: on a page with no daemon the host makes it (it needs the person's password); otherwise the box does. */
export const replaceCode = async (password?: string): Promise<unknown> => (hostWanted() ? getHost().call("identity.code.replace", { password: password ?? "" }) : source.replaceCode(password));
/** Take a device off the list. */
export const removeEntry = async (eid: string): Promise<unknown> => (hostWanted() ? getHost().call("identity.entry.remove", { eid }) : source.removeEntry(eid));
/** Does Account on this page need the person's password to make a new recovery code (the host signs it, the box is not asked)? */
export const needsPasswordForCode = (): boolean => hostWanted();

/** Why private chats could not be set up on this page (the unlock-time repair), or "" when nothing is wrong or this page has no host. */
export const chatSetupProblem = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.agree.status")) as { failed?: string }).failed ?? "" : "");
export const retryChatSetup = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.agree.retry")) as { failed?: string }).failed ?? "" : "");
/** Why a Space's address could not be put on its server (the owner's server listing with the names directory), or "" when nothing is wrong or this page has no host. */
export const listingProblem = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.servers.status")) as { failed?: string }).failed ?? "" : "");
export const retryListing = async (): Promise<string> => (hostWanted() ? ((await getHost().call("identity.servers.retry")) as { failed?: string }).failed ?? "" : "");

/** Can the name be changed here (a page whose host keeps it)? */
export const canSetName = (): boolean => hostWanted();
/** Change the name shown for the person: one line with a letter, up to 60 characters. */
export const setDisplayName = async (display: string): Promise<string> => ((await getHost().call("identity.display.set", { display })) as { display: string }).display;
