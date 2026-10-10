// Types for the platform files: GlassFrame.web.tsx (an iframe on the page public/glass/frame.html) and GlassFrame.native.tsx (nothing: Glass is the web app's for 0.2.9).
import type { ReactNode, Ref } from "react";

export type GlassFrameHandle = { post: (m: Record<string, unknown>) => void };
export type GlassFrameProps = { src: string; onMessage: (m: any) => void; frameRef?: Ref<GlassFrameHandle>; label: string; relay?: boolean; openSocket?: (path: string) => any };
export function GlassFrame(p: GlassFrameProps): ReactNode;
