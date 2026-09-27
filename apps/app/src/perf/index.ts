// The perf meter (ADR 0027, section 6): one instance for the whole app, DOM-free.
import { createMeter } from "../../perf/meter.js";

export { BAR, createMeter, percentile } from "../../perf/meter.js";
export type Meter = ReturnType<typeof createMeter>;

export const meter: Meter = createMeter();
