import { callT as call } from "../../src/real/call-tool";
import { onboardSource } from "./source";

export const { read, you, skip, history, finish, retry } = onboardSource(call);
