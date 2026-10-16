import { allowsMock } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { spaceDriveSource } from "./space-source";
import { linkedSource } from "./linked-source";
import { sampleCall } from "./mock-box";
import type { Call } from "./source";

/** The Space Drive's calls go through `tool`, which answers a presence request (restore) with the person's own proof. */
const callWithPresence: Call = async (name, input) => {
  if (allowsMock()) return sampleCall(name, input);
  try { return { data: (await tool(name, input ?? {})) as never }; } catch (e) { const x = e as { code?: string; message?: string }; return { error: { code: x.code ?? "error", message: x.message ?? "" } }; }
};
export const { list: spaceList, read: spaceRead, upload: spaceUpload, versions: spaceVersions, restore: spaceRestore, linkCreate, linkList, linkRevoke } = spaceDriveSource(callWithPresence);

/** Files > Linked: linking, saving back and unlinking are the person's own acts, so they go through `tool` like the Space Drive's. */
export const linked = linkedSource(callWithPresence);
