import { callT as call } from "../../src/real/call-tool";
import { runnerSource } from "./runner-source";

export const runner = runnerSource(call);
