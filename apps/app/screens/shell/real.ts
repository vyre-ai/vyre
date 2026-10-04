import { call } from "../../src/api/box";
import { shellFrom, type ShellData } from "./real-model";
import { shellSource } from "./real-source";

const source = shellSource(call);
/** The shell's data from the box. */
export async function loadReal(): Promise<ShellData> {
  const r = await source.load();
  return shellFrom(r.spaces, r.identity);
}
