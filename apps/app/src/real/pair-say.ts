import { Platform } from "react-native";
import { deviceKind, pairSayFor } from "../../screens/install/first-run.js";
import { shell } from "../shell/shell";

/** This device's kind: iPhone, Android, the Mac app's window, or a browser. */
export const deviceKindHere = () => deviceKind(Platform.OS, !!shell());

/** A pairing sentence as this device says it: a phone or browser never reads "server" or an install line for a pairing (first-run.js pairSayFor). */
export const pairSayHere = (text: string): string => pairSayFor(text, deviceKindHere());
