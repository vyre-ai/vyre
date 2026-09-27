import { useEffect, useState } from "react";
import { meter, perfOn, type Meter } from "./index";

declare global {
  interface Window {
    __vyrePerf?: Meter;
  }
}

/**
 * With ?perf=1 (or the flag this device kept, src/perf/flag.js), feeds meter.frame from requestAnimationFrame while the page is visible, records
 * long tasks where the browser reports them, and exposes the meter as window.__vyrePerf so CI can
 * call report(). Without the flag it does nothing, so it costs nothing.
 */
export function usePerfOverlay(): boolean {
  const [on] = useState(perfOn);
  useEffect(() => {
    if (!on) return;
    window.__vyrePerf = meter;
    let raf = 0;
    const tick = (t: number) => {
      meter.frame(t);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      meter.pause();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", onVisibility);
    start();

    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) meter.longTask(e.duration, e.startTime);
      });
      observer.observe({ type: "longtask" });
    }

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (window.__vyrePerf === meter) delete window.__vyrePerf;
    };
  }, [on]);
  return on;
}
