// @ts-check
// The promise a person agrees to when they sign up for the weekly update. The Worker stores CONSENT_VERSION with each row;
// scripts/site/updates.mjs prints CONSENT_TEXT beside the checkbox. Change the words only together with the version, because a
// stored row must say which promise the person saw.

export const CONSENT_TEXT = "One email a week with what changed in Vyre. Never more. Unsubscribe any time.";
export const CONSENT_VERSION = "2026-10-14.1";
