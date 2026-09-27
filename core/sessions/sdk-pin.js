// @ts-check
// The SDK's name and pinned version, with no imports: box/Dockerfile copies this one file into
// the image build and reads it before the rest of Vyre is there (core/sessions/sdk.js re-exports it).

export const PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** Pinned: the SDK is pre-1.0 and changes weekly. A bump runs the switchboard suite on the SDK first. */
export const VERSION = "0.3.283";
