import { call } from "../../src/api/box";
import { driveSource } from "./source";

export const { statusReal, listReal, readReal } = driveSource(call);
