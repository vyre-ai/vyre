import { callT as call } from "../../src/real/call-tool";
import { limitsSource } from "./limits-source";

export const limits = limitsSource(call);
