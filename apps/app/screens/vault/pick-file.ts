// Choosing a file to import. Only a browser (and so the Mac app and the web app) can read a file from the person's computer; the phone app says to use the Mac or the web.
import type { Picked } from "./import-source";

/** Whether this build can open a file picker. */
export const canPick = false;
/** Open the file picker for these extensions. Null when the person closes it. */
export async function pickFile(_accept: string): Promise<Picked | null> { return null; }
