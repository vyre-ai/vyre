// Types for the platform files: Frame.web.tsx (the visualViewport inset) and Frame.native.tsx
// (KeyboardAvoidingView).
import type { ReactNode } from "react";

/** The session's body: the transcript above, the composer below, both riding the keyboard in one frame. */
export function Frame(p: { transcript: ReactNode; composer: ReactNode }): ReactNode;
