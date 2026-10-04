import { callT as call } from "../../src/real/call-tool";
import { appearanceSource } from "./appearance-source";

export const { scheme: readScheme, setScheme } = appearanceSource(call);
