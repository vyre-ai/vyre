import { call as boxCall } from "../../src/api/box";
import { getHost, hostWanted } from "../../src/host";
import { pickIdentity, shellFrom, type IdentityRow, type ShellData } from "./real-model";
import { shellSource, type Call } from "./real-source";

/** The Spaces this identity made or joined from this app are kept by the app's own host, not by any server: on a page with no daemon of its own that list is the host's answer, so the switcher shows them beside each server's. */
const call: Call = async (tool, input) => {
  if (tool === "onboard.space.list" && hostWanted() && getHost().has(tool)) {
    try { return { data: (await getHost().call(tool, input)) as never }; }
    catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
  }
  return boxCall(tool, input) as never;
};
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
