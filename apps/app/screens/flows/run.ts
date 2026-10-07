import { callT as call } from "../../src/real/call-tool";
import { runSource } from "./run-source";

export const { startReal, retryReal } = runSource(call);
