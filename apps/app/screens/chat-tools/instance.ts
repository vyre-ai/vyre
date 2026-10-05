import { callT as call } from "../../src/real/call-tool";
import { chatToolsSource } from "./source";

export const chatTools = chatToolsSource(call);
