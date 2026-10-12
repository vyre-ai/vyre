// @ts-check
// The shape of an account's approved-skills seed, decided in ONE place: the Switchboard builds a set that fits it and the root spawner refuses anything that does not. A set lives under one fixed prefix and a
// 16-hex content id, in plain names, so nothing else of an account's HOME is reachable through it.

/** Where an account's approved skills are written. */
export const SKILLS_PREFIX = ".vyre-skills/";
/** What one skills set may hold, checked before any write. */
export const SKILLS_CAPS = Object.freeze({ files: 128, file: 65536, total: 524288 });
const SKILLS_KEY = /^\.vyre-skills\/[0-9a-f]{16}\/(?:[A-Za-z0-9_.-]{1,80}\/){0,6}[A-Za-z0-9_.-]{1,100}$/;
/** Is this seed key a file of a skills set (the prefix, a 16-hex content id, plain names, at most 6 folders deep, no dot segment)? @param {string} k */
export const skillsKeyOk = k => SKILLS_KEY.test(k) && !k.split("/").some(seg => seg === "." || seg === "..");
