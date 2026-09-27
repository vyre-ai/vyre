// @ts-check
// The Agent SDK version Vyre runs on (ADR 0030). It imports nothing, so box/Dockerfile can copy
// this one file into the image build and read the pin from it alone. sdk.js re-exports both.

export const PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** Pinned: the SDK is pre-1.0 and changes weekly. A bump runs the switchboard suite on the SDK first. */
export const VERSION = "0.3.283";
