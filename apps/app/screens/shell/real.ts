import { call as boxCall } from "../../src/api/box";
import { getHost, hostWanted } from "../../src/host";
import { shellFrom, type ShellData } from "./real-model";
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
/** The shell's data from the box. */
export async function loadReal(): Promise<ShellData> {
  const r = await source.load();
  return shellFrom(r.spaces, r.identity);
}
