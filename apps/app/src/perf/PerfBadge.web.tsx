// The ?perf=1 overlay (ADR 0027 section 6): a small fixed badge with the live fps, the dropped
// frames over the last 10 s and the last verdict against the bar. A tap copies meter.report() as
// JSON. Without ?perf=1 it renders nothing and runs no timer, so it costs nothing.

import { useEffect, useState } from "react";
import { tokens } from "../theme/tokens";
import { meter, perfOn } from "./index";

type View = { fps: number; dropped: number; pass: number; fail: number; open: number; failed: string[] };

function read(): View {
  const r = meter.report();
  const v = r.verdict;
  return {
    fps: Math.round(r.frames.fps),
    dropped: Math.round(r.frames.droppedPct * 10) / 10,
    pass: v.filter((c) => c.pass === true).length,
    fail: v.filter((c) => c.pass === false).length,
    open: v.filter((c) => c.pass === null).length,
    failed: v.filter((c) => c.pass === false).map((c) => c.id),
  };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function PerfBadge() {
  if (!perfOn) return null;
  return <Badge />;
}

function Badge() {
  const [v, setV] = useState<View>(read);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setV(read()), 500);
    return () => clearInterval(t);
  }, []);
  const verdict = v.fail ? `fail: ${v.failed.join(", ")}` : `${v.pass} pass · ${v.open} open`;
  return (
    <button
      type="button"
      aria-label="Copy the perf report"
      onClick={async () => {
        setCopied(await copy(JSON.stringify(meter.report(), null, 2)));
        setTimeout(() => setCopied(false), 1200);
      }}
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 6px)",
        right: 6,
        zIndex: 1000,
        font: "600 11px/14px ui-monospace, Menlo, monospace",
        color: tokens.color.dark.text,
        background: v.fail ? tokens.color.dark.ruleStrong : tokens.color.dark.scrim,
        border: `1px solid ${tokens.color.dark.ruleStrong}`,
        borderRadius: 6,
        padding: "3px 6px",
        pointerEvents: "auto",
        touchAction: "manipulation",
        cursor: "pointer",
      }}
    >
      {copied ? "copied" : `${v.fps} fps · ${v.dropped}% · ${verdict}`}
    </button>
  );
}
