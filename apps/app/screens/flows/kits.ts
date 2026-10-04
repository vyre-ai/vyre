import { callT as call } from "../../src/real/call-tool";
import { kitsSource } from "./kits-source";

export const { list: listKits, library: listLibrary, card: kitCard, propose: proposeKit, remove: removeKit } = kitsSource(call);
