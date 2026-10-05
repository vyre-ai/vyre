import { callT as call } from "../../src/real/call-tool";
import { chatToolsSource } from "./source";
import { moreToolsSource } from "./more-source";

export const chatTools = chatToolsSource(call);
export const moreTools = moreToolsSource(call);
