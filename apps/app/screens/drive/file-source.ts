// The Space Drive as a FileSource for the file viewer (ui/files): read a version, list the versions, save text as a new version. These are the existing files.drive.space.* and files.drive.* tools.
import { linked, spaceRead, spaceUpload, spaceVersions } from "./real";
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

/** A file in a linked folder as a FileSource: the content is fetched from the source now, a save goes back with the rev it was opened at (a stale one is refused with `conflict` and nothing is written), and the versions are the source's own history. */
export function linkedFileSource(link: string, path: string): FileSource {
  let rev: string | undefined;
  return {
    load: async () => {
      const r = await linked.read(link, path);
      rev = r.rev;
      return { bytes: bytesOf(r.base64), base64: r.base64, mime: r.mime };
    },
    versions: async () => (await linked.versions(link, path)).map((v, i) => ({ ver: i + 1, at: v.modified, by: v.by ?? null })),
    save: async (text) => {
      const r = await linked.write(link, path, base64Of(bytesOfText(text)), rev);
      rev = r.rev;
      return { version: Number(r.rev) || undefined };
    },
  };
}
