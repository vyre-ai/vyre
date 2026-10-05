import { allowsMock } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { sampleCall } from "../drive/mock-box";
import { chatToolsSource } from "./source";
import { moreToolsSource } from "./more-source";

/** In a mock build the artifacts the Drive Shared tab lists come from the sample world; every other tool goes to the box. */
const call = (<T = unknown>(name: string, input?: Record<string, unknown>) => (allowsMock() && name.startsWith("artifacts.") ? sampleCall<T>(name, input) : callT<T>(name, input))) as typeof callT;

export const chatTools = chatToolsSource(call);
export const moreTools = moreToolsSource(call);
