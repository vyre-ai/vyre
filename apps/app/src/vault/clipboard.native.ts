import * as Clipboard from "expo-clipboard";
import { Platform } from "react-native";
import type { Board } from "./clip-model";

// The phone's clipboard. Never read: on iOS a read shows the paste banner, so clearing is by
// "nothing else copied by the app since" (clip-model.ts, the "if-last" plan).

export const board: Board = {
  os: Platform.OS,
  async write(pending) {
    const value = await pending;
    if (value === null) return false;
    try {
      return await Clipboard.setStringAsync(value);
    } catch {
      return false;
    }
  },
  async readsSilently() {
    return false;
  },
  async read() {
    return null;
  },
  async clear() {
    await Clipboard.setStringAsync("");
  },
};
