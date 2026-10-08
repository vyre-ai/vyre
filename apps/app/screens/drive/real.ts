import { tool } from "../../src/real/box";
import { driveSource } from "./source";
import { spaceDriveSource } from "./space-source";
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
export const { list: spaceList, read: spaceRead, upload: spaceUpload, versions: spaceVersions, restore: spaceRestore, linkCreate, linkList, linkRevoke } = spaceDriveSource(callWithPresence);
