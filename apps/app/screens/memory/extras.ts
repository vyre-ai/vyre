import { call } from "../../src/api/box";
import { memoryExtras } from "./extras-source";

export const { askReal, graphReal, steerReal, correctionsReal, uncorrectReal } = memoryExtras(call);
