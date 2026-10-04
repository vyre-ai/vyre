// @ts-check
// The ONE list of the person's own surfaces (the lead's ruling, 5 Oct): cli (with real ancestry), local, deck, capsule. Nothing else is a surface by label. A paired device (`device:<id>`) is the person only with a
// person session (lib/caller.js ownerDevice and isPerson), and a bare `mobile` is not here: the phone arrives as its paired device, and a label any caller can claim must not make a person. This file has no
// imports so core/modules and core/presence can take the list from it without a cycle; lib/caller.js re-exports it, and no other file keeps its own copy of the identity list.
export const PERSON_SURFACES = Object.freeze(["cli", "local", "deck", "capsule"]);
