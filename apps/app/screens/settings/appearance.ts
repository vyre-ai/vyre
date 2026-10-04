import { call } from "../../src/api/box";
import { appearanceSource } from "./appearance-source";

export const { scheme: readScheme, setScheme } = appearanceSource(call);
