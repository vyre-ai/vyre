// The Space Drive as a FileSource for the file viewer (ui/files): read a version, list the versions, save text as a new version. These are the existing files.drive.space.* and files.drive.* tools.
import { spaceRead, spaceUpload, spaceVersions } from "./real";
import { bytesOf } from "./real-model";
import { base64Of, bytesOfText } from "../../ui/files/viewer-model.js";
import type { FileSource, FileVersion } from "../../ui/files/source";

/** A file in the Space's Drive. */
export function driveSource(path: string, space?: string): FileSource {
  return {
    load: async (version) => {
      const r = await spaceRead(space, path, version);
      return { bytes: bytesOf(r.base64), base64: r.base64 };
    },
    versions: async () => {
      const r = (await spaceVersions(space, path)) as unknown as FileVersion[];
      return r.map((v) => ({ ver: v.ver, at: v.at, by: v.by, size: v.size, deleted: v.deleted, conflict: v.conflict }));
    },
    save: async (text, base) => {
      const r = await spaceUpload(space, path, base64Of(bytesOfText(text)), base);
      return { version: r.version, conflict: r.conflict };
    },
  };
}
