// Types for the platform files: TerminalFrame.web.tsx (an iframe) and TerminalFrame.native.tsx (react-native-webview).
// Both load the same page (public/term/frame.html, made by scripts/term-assets.mjs) and carry the same JSON messages.
import type { ReactNode, Ref } from "react";

export type FrameHandle = { post: (m: Record<string, unknown>) => void };
export type FrameProps = {
  src: string;
  onMessage: (m: any) => void;
  /** A colour to show behind the page while it loads. */
  background?: string;
  frameRef?: Ref<FrameHandle>;
  testID?: string;
};
export function TerminalFrame(p: FrameProps): ReactNode;
