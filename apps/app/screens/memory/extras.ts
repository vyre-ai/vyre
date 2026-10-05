import { callT as call } from "../../src/real/call-tool";
import { memoryExtras } from "./extras-source";

export const { askReal, graphReal, steerReal, correctionsReal, uncorrectReal } = memoryExtras(call);
