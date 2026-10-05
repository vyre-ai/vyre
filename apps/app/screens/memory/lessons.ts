import { callT as call } from "../../src/real/call-tool";
import { lessonsSource } from "./lessons-source";

export const lessons = lessonsSource(call);
