// The Files screen's real sources, from the same calls the Space Drive and linked folders already use (real.ts). `linkedNames` is filled by the screen as it learns the linked folders.
import { filesLoader } from "./files-source.ts";
import { linked, spaceList } from "./real";

export const linkedNames: Record<string, string> = {};
export const loader = filesLoader({ space: { list: spaceList }, linked, linkedNames: () => linkedNames });
