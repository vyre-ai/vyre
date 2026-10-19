import { callT as call } from "../../src/real/call-tool";
import { settingsSource } from "./real-source";
import { getHost, hostWanted } from "../../src/host";
import type { Entry, Identity } from "./account-model";

const source = settingsSource(call);
export const { updateStatus, updateCheck, updateApply, pushSettings, pushSet, pushDevices, agentsList, agentsUsage, agentStop, agentResume, agentDelete, providers, replaceCode, removeEntry, types } = source;

// A page with no daemon (the Mac window with no vyred, the hosted web app) keeps the person's name in its own host, and its server's box holds none ("No Vyre name on this device yet"): the name and the list of
// devices are read there and from the names directory, not from the box.
export const identity = async (): Promise<Identity> => {
  if (!hostWanted()) return source.identity();
  const s = (await getHost().call("identity.status")) as { exists?: boolean; username?: string | null; id?: string | null };
  return s.exists ? { exists: true, name: s.username ?? undefined, id: s.id ?? undefined } : { exists: false };
};
export const entries = async (): Promise<Entry[]> => {
  if (!hostWanted()) return source.entries();
  return ((await getHost().call("identity.entries")) as { entries?: Entry[] }).entries ?? [];
};
