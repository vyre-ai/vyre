// The questions the golden recorder asks: caller shapes and worlds. Both lists are append-only; a
// reordering changes every row.

/** Caller strings as the registry sees them. `caller(reg)` may look at the booted registry. */
export const CALLERS = Object.freeze([
  { id: "cli", caller: () => "cli" },
  { id: "local", caller: () => "local" },
  { id: "deck", caller: () => "deck" },
  { id: "capsule", caller: () => "capsule" },
  { id: "mobile", caller: () => "mobile" },
  { id: "mcp", caller: () => "mcp" },
  { id: "harness", caller: () => "harness" },
  { id: "mcp:agent:kit", caller: () => "mcp:agent:kit" },
  { id: "cli:agent:kit", caller: () => "cli:agent:kit" },
  { id: "mcp:agent:", caller: () => "mcp:agent:" },
  { id: "device", caller: () => "device:abcdefghijklmnop" },
  { id: "module:first-party", caller: reg => "module:" + firstPartyName(reg) },
  { id: "module:added", caller: () => "module:zz-added" },
  { id: "hook", caller: () => "hook" },
  { id: "onboard", caller: () => "onboard" },
  { id: "anonymous", caller: () => "anonymous" },
  { id: "unknown", caller: () => "unknown" },
  // An assistant PROVEN by the daemon: the call arrived on a session's own socket (or a vouched key), so `meta.thread` is bound. Appended last so no row's order changes.
  { id: "session:mcp:agent:kit", caller: () => "mcp:agent:kit", meta: { thread: "t1", agent: "kit" } },
  { id: "session:harness:agent:kit", caller: () => "harness:agent:kit", meta: { thread: "t1", agent: "kit" } },
  // The labels the Wink network issues (TAILSCALE-removal step 2): a visiting person in a Space, and an agent's own label. Appended last so no row's order changes.
  { id: "space:alex@harlow", caller: () => "space:alex@harlow" },
  { id: "agent:kit", caller: () => "agent:kit" },
]);

/** Meta states: the person's session, a presence proof, an asked-for match, a named project. */
export const WORLDS = Object.freeze([
  { id: "bare", person: false, proof: false, said: false, named: false },
  { id: "person", person: true, proof: false, said: false, named: false },
  { id: "person+proof", person: true, proof: true, said: false, named: false },
  { id: "person+proof+said", person: true, proof: true, said: true, named: false },
  { id: "named", person: true, proof: true, said: true, named: true },
]);

/**
 * K2-9: callers outside the golden matrix, for the generated differential test (old inline rules against the gates). Case,
 * spacing, unicode and odd names are the strings where a re-reading `parseCaller` could differ from the registry's own helpers.
 */
export const GENERATED_CALLERS = Object.freeze((() => {
  const base = ["cli", "local", "deck", "capsule", "mobile", "mcp", "harness", "hook", "onboard", "link", "relay", "anonymous"];
  const out = new Set();
  for (const b of base) for (const v of [b, b.toUpperCase(), ` ${b}`, `${b} `, `${b}:`, `${b}:agent:kit`, `${b}:agent:`, `${b}:agent: kit`, `${b}\n`, `${b}\u0000`, `${b}\u212a`, `${b}:x`, `${b}@x`]) out.add(v);
  for (const m of ["module:", "module:x", "module: x", "module:X", "module:a:b", "module:\u00e9", "module:zz-added", "Module:x", "module:../x"]) out.add(m);
  for (const d of ["device:", "device:abcdefghijklmnop", "device:ABCDEFGHIJKLMNOP", "device:abc", "device:abcdefghijklmnopq", "device: abcdefghijklmnop", "device:abcdefghijklmnop:x", "Device:abcdefghijklmnop"]) out.add(d);
  for (const a of ["cli:agent:Kit", "mcp:agent:k\u00efit", "harness:agent:a b", "agent:kit", ":agent:kit", "cli:agent:kit:more", "cli:AGENT:kit"]) out.add(a);
  for (const sp of ["space:alex@harlow", "space:", "space:alex", "space:@harlow", "space:alex@", "Space:alex@harlow", "space :alex@harlow", "space:alex@harlow:agent:kit", "space:al\u200bex@harlow"]) out.add(sp);
  for (const d of ["device :abcdefghijklmnop", "device:abcdefghij\u200bklmnop"]) out.add(d);
  return [...out].map((c, i) => ({ id: `g${i}:${JSON.stringify(c)}`, caller: () => c }));
})());

let fp = null;
function firstPartyName(reg) {
  if (fp) return fp;
  for (const [name, r] of reg.modules.entries()) if (r.dir && reg.isFirstParty(r.dir)) { fp = name; break; }
  return fp || "vyred";
}
