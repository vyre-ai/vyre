// Where the viewer gets a file from and how it saves one: the Space Drive's own tools (screens/drive), as a FileSource the viewer takes. A project's or agent's instructions pass their own (projects.docs.set and so on).
import { spaceRead, spaceUpload, spaceVersions } from "../../screens/drive/real";
import { bytesOf } from "../../screens/drive/real-model";
import { base64Of } from "./viewer-model.js";

export type FileVersion = { ver: number; at?: number | string; by?: string | null; size?: number; deleted?: boolean; conflict?: boolean };
export type FileBody = { bytes?: ArrayLike<number>; text?: string; mime?: string };
export type SaveResult = { version?: number; conflict?: boolean } | void;

export type FileSource = {
  /** The file's bytes (or text), the head or one version. */
  load: (version?: number) => Promise<FileBody>;
  /** The versions, newest last. Absent: no version picker. */
  versions?: () => Promise<FileVersion[]>;
  /** Save text as a NEW version. `base` is the version it was edited from. Absent: read only. */
  save?: (text: string, base?: number) => Promise<SaveResult>;
};

/** A file in the Space's Drive. */
export function driveSource(path: string, space?: string): FileSource {
  return {
    load: async (version) => {
      const r = await spaceRead(space, path, version);
      return { bytes: bytesOf(r.base64) };
    },
    versions: async () => {
      const r = (await spaceVersions(space, path)) as unknown as FileVersion[];
      return r.map((v) => ({ ver: v.ver, at: v.at, by: v.by, size: v.size, deleted: v.deleted, conflict: v.conflict }));
    },
    save: async (text, base) => {
      const { bytesOfText } = await import("./viewer-model.js");
      const r = await spaceUpload(space, path, base64Of(bytesOfText(text)), base);
      return { version: r.version, conflict: r.conflict };
    },
  };
}
