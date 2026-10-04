import { call } from "../../src/api/box";
import { kitsSource } from "./kits-source";

export const { list: listKits, remove: removeKit } = kitsSource(call);
