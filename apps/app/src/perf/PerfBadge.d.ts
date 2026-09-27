// Types for the platform files: PerfBadge.web.tsx and PerfBadge.native.tsx.
import type { ReactNode } from "react";
/** The ?perf=1 badge: fps, dropped frames, the verdict; a tap copies meter.report() as JSON. Nothing when the meter is off. */
export function PerfBadge(): ReactNode;
