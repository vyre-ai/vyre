import { useEffect, useState } from "react";
import { create } from "zustand";
import { createPhotoCache, photoRef } from "./photo-model.js";

type S = {
  looks: Record<string, string>;
  /** Profile photos by person id and by lower-case name: the photo record's address in its Space (src/state/profiles.ts sets it with the profiles). */
  photos: Record<string, string>;
  /** How a photo is read, set by the app (records.get through the Space's door); the library itself calls no box. */
  read: ((ref: string) => Promise<string>) | null;
  set: (looks: Record<string, string>) => void;
  setPhotos: (photos: Record<string, string>) => void;
  setReader: (read: (ref: string) => Promise<string>) => void;
};

/** The looks people chose in their Space profiles, by lower-case name: set by the app when it reads a Space's profiles, read by every person's face drawn with no look of its own (a chat message, a member row), so a person looks the same wherever their name shows. Their photos come the same way. */
export const usePersonLooks = create<S>((set) => ({
  looks: {}, photos: {}, read: null,
  set: (looks) => set({ looks }),
  setPhotos: (photos) => set({ photos }),
  setReader: (read) => set({ read }),
}));

/** Every photo read in this run, shared by all faces: each is read once and kept (a photo's id names one picture for good). */
export const photoCache = createPhotoCache({ max: 64 });

/** The photo a person's face draws, as a data address, or "" while it has none or it is still on its way (the face shows meanwhile, in the same box). */
export function usePersonPhoto(of: { kind: string; id: string; name: string } | null, face = false): string {
  const ref = usePersonLooks((s) => photoRef(of, s.photos, face));
  const read = usePersonLooks((s) => s.read);
  // the photo kept with the address it is for, so a face that is handed another person never shows the last one's photo for a frame
  const [got, setGot] = useState<{ ref: string; uri: string }>(() => ({ ref, uri: ref ? photoCache.get(ref) ?? "" : "" }));
  useEffect(() => {
    if (!ref || !read || photoCache.get(ref) !== undefined) return;
    let live = true;
    void photoCache.load(ref, read).then((uri) => { if (live) setGot({ ref, uri }); });
    return () => { live = false; };
  }, [ref, read]);
  if (!ref) return "";
  return photoCache.get(ref) ?? (got.ref === ref ? got.uri : "");
}
