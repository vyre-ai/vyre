import { call } from "../../src/api/box";
import { kitsSource } from "./kits-source";

export const { list: listKits, library: listLibrary, card: kitCard, propose: proposeKit, remove: removeKit } = kitsSource(call);
