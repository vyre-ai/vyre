// A profile photo from the person's own pictures: picked (the system photo picker on a phone, a file chooser on the web), cropped in PhotoCropSheet, then drawn again at about 512 pixels and encoded
// (WebP; JPEG on iOS, whose encoder has no WebP, and on a browser that cannot write WebP), smaller in steps until it is under 200 KB. Drawing the pixels again leaves the camera's EXIF and location
// behind; stripMeta takes out anything an encoder still wrote. The same code on the web, iOS and Android: expo-image-picker and expo-image-manipulator, each loaded only when a photo is picked.
import { Platform } from "react-native";
import { PHOTO_MAX_BYTES, QUALITIES, nextQuality, outputSide, sniff, stripMeta, type Crop, type CropPick } from "@vyre/ui";
import { fromB64, toB64 } from "../../../../lib/databox.js";

export type Picture = { base64: string; mime: string; bytes: number; side: number };

/** One picture the person picks from their photos or files, or null when they close the picker. */
export async function pickPhoto(): Promise<CropPick | null> {
  const ImagePicker = await import("expo-image-picker");
  // no editing in the system picker (the crop is ours, the same everywhere), no EXIF asked for, and the photo itself, not a copy shrunk by the picker
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: false, exif: false, base64: false, quality: 1 });
  const a = !r.canceled && r.assets ? r.assets[0] : null;
  if (!a || !a.uri || !(a.width > 0) || !(a.height > 0)) return null;
  return { uri: a.uri, width: a.width, height: a.height };
}

/** The kept square as the photo that is saved: at most 512 pixels a side, at most 200 KB, no notes in it. Throws in words when even the smallest try is too large. */
export async function encodePhoto(pick: CropPick, crop: Crop): Promise<Picture> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const side = outputSide(crop);
  const img = await ImageManipulator.manipulate(pick.uri).crop(crop).resize({ width: side, height: side }).renderAsync();
  try {
    let format = Platform.OS === "ios" ? SaveFormat.JPEG : SaveFormat.WEBP;
    let q: number | null = QUALITIES[0];
    while (q !== null) {
      const out = await img.saveAsync({ format, compress: q, base64: true });
      const clean = stripMeta(fromB64(out.base64 ?? ""));
      const mime = sniff(clean);
      // a browser that cannot write WebP hands back a PNG instead: try JPEG at the same quality
      if (format === SaveFormat.WEBP && mime !== "image/webp") { format = SaveFormat.JPEG; continue; }
      if (mime && clean.length <= PHOTO_MAX_BYTES) return { base64: toB64(clean), mime, bytes: clean.length, side };
      q = nextQuality(q);
    }
  } finally {
    (img as unknown as { release?: () => void }).release?.();
  }
  throw new Error("That picture is still over 200 KB at its smallest. Try another one.");
}
