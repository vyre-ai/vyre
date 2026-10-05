import { callT as call } from "../../src/real/call-tool";
import { memoryExtras } from "./extras-source";

export const { statsReal, whyReal, askReal, graphReal, steerReal, correctionsReal, uncorrectReal } = memoryExtras(call);
