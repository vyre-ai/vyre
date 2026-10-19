import { allowsMock } from "@vyre/ui";
import { call as boxCall } from "../../src/api/box";
import { tool } from "../../src/real/box";
import { driveSource } from "./source";
import { spaceDriveSource } from "./space-source";
import { linkedSource } from "./linked-source";
import { sampleCall } from "./mock-box";
import type { Call } from "./source";

/** In a mock build the one Drive screen is fed by the sample world through the same tools; everywhere else the box answers. */
const call: Call = (name, input) => (allowsMock() ? sampleCall(name, input) : boxCall(name, input));

export const { statusReal, listReal, readReal } = driveSource(call);

/** The Space Drive's calls go through `tool`, which answers a presence request (restore) with the person's own proof. */
const callWithPresence: Call = async (name, input) => {
  if (allowsMock()) return sampleCall(name, input);
  try { return { data: (await tool(name, input ?? {})) as never }; } catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
};
/** One Drive call by name, answering its data or throwing its refusal (code and message): the edits of Files (move, rename, delete and their undo) go through it, so the sample world answers them in a mock build. */
export async function driveTool<T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await callWithPresence(name, input);
  if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return (r ? r.data : undefined) as T;
}
export const { list: spaceList, read: spaceRead, upload: spaceUpload, versions: spaceVersions, restore: spaceRestore, linkCreate, linkList, linkRevoke } = spaceDriveSource(callWithPresence);

/** Files > Linked: linking, saving back and unlinking are the person's own acts, so they go through `tool` like the Space Drive's. */
export const linked = linkedSource(callWithPresence);
