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
  { id: "tailnet:owner", caller: () => "tailnet:owner@example.com" },
  { id: "tailnet:agent:kit", caller: () => "tailnet:agent:kit" },
  { id: "tailnet-guest", caller: () => "tailnet-guest:guest@example.com" },
  { id: "device", caller: () => "device:abcdefghijklmnop" },
  { id: "module:first-party", caller: reg => "module:" + firstPartyName(reg) },
  { id: "module:added", caller: () => "module:zz-added" },
  { id: "hook", caller: () => "hook" },
  { id: "onboard", caller: () => "onboard" },
  { id: "anonymous", caller: () => "anonymous" },
  { id: "unknown", caller: () => "unknown" },
]);

/** Meta states: the person's session, a presence proof, an asked-for match, a named project. */
export const WORLDS = Object.freeze([
  { id: "bare", person: false, proof: false, said: false, named: false },
  { id: "person", person: true, proof: false, said: false, named: false },
  { id: "person+proof", person: true, proof: true, said: false, named: false },
  { id: "person+proof+said", person: true, proof: true, said: true, named: false },
  { id: "named", person: true, proof: true, said: true, named: true },
]);

let fp = null;
function firstPartyName(reg) {
  if (fp) return fp;
  for (const [name, r] of reg.modules.entries()) if (r.dir && reg.isFirstParty(r.dir)) { fp = name; break; }
  return fp || "vyred";
}
