import { callT as call } from "../../src/real/call-tool";
import { outsideSource } from "./outside-source";

export const outside = outsideSource(call);
