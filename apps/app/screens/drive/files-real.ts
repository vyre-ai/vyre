// The Files screen's real sources, from the same calls the Space Drive, linked folders and box shares already use (real.ts). `linkedNames` is filled by the screen as it learns the linked folders.
import { filesLoader } from "./files-source.ts";
import { linked, listReal, spaceList } from "./real";

export const linkedNames: Record<string, string> = {};
export const loader = filesLoader({ space: { list: spaceList }, linked, box: { list: listReal }, linkedNames: () => linkedNames });
