import { callT as call } from "../../src/real/call-tool";
import { configSource } from "./config-source";

export const config = configSource(call);
