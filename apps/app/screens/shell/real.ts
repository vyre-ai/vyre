import { call } from "../../src/api/box";
import { getHost, hostWanted } from "../../src/host";
import { pickIdentity, shellFrom, type IdentityRow, type ShellData } from "./real-model";
import { shellSource } from "./real-source";

const source = shellSource(call);
/** The person on this computer, when the page has its own host (the Mac app on a server's address): the box holds no identity of theirs, but the host does, and Settings reads it there. */
async function hostIdentity(): Promise<IdentityRow | null> {
  if (!hostWanted()) return null;
  try {
    const s = (await getHost().call("identity.status")) as { exists?: boolean; username?: string | null; display?: string };
    return s?.exists ? { exists: true, name: s.username ?? undefined, ...(s.display ? { label: s.display } : {}) } : null;
  } catch { return null; }
}
/** The shell's data from the box. The person's name comes from the box's identity, else from this computer's own, so the foot never reads "You" for someone with a name. */
export async function loadReal(): Promise<ShellData> {
  const r = await source.load();
  return shellFrom(r.spaces, pickIdentity(r.identity, r.identity?.name || r.identity?.label ? null : await hostIdentity()));
}
