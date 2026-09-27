import { StyleSheet } from "react-native";
import { faces } from "./fonts";
import { tokens } from "./tokens";

// The type steps (tokens.type.phone) with their faces, one style each, so no screen sets a size,
// a line height, a family or a weight of its own. Mono is 13 on the base line, 12 on the meta line.

const step = ([fontSize, lineHeight]: readonly [number, number]) => ({ fontSize, lineHeight });
const phone = tokens.type.phone;
const [monoSmall, monoBase] = tokens.type.mono;

export const type = StyleSheet.create({
  meta: { ...faces.regular, ...step(phone.meta) },
  metaStrong: { ...faces.strong, ...step(phone.meta) },
  base: { ...faces.regular, ...step(phone.base) },
  baseStrong: { ...faces.strong, ...step(phone.base) },
  read: { ...faces.regular, ...step(phone.read) },
  readStrong: { ...faces.strong, ...step(phone.read) },
  title: { ...faces.strong, ...step(phone.title) },
  hero: { ...faces.strong, ...step(phone.hero) },
  mono: { ...faces.mono, fontSize: monoBase, lineHeight: phone.base[1] },
  monoMeta: { ...faces.mono, fontSize: monoSmall, lineHeight: phone.meta[1] },
});

/** Only the face, for a run inside a line that keeps the line's size (a path in a tool row). */
export const face = faces;
