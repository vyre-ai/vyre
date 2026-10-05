// Pair this computer with the person's Vyre by the typed code another device shows (WINK-NNPP-PPPP). The same relay client every device uses (relay/client/join.js): type the code,
// show the ack code to type back on the showing device (that typing is the person's yes), then the pairing is made and the shell keeps it. The device key stays in Rust (DPAPI); the
// client asks the shell for DH results only (relay/shellkey.js). A bundled local page: the only kind that may call the shell's commands. Nothing here logs or keeps the code.
//
// `deps` is the seam the test passes: { joinWithCode, shellDeviceKey, invoke, relay }.

export const SAY = {
  format: "That is not a code. It looks like WINK-7K4Q-M2XD.",
  busy: "Too many tries. Wait a minute and type it again.",
  offline: "This computer cannot reach the relay. Check that it is online, then try again.",
  refused: "That code is not right. Check the other device and type it again.",
  closed: "That code ended. Make a new one on your other device.",
  expired: "That code ran out of time. Make a new one on your other device.",
  nothing: "The pairing worked but gave no address for your Vyre. Enter its address below.",
};

/**
 * @param {{ input: string, onAck?: (code: string) => void, onState?: (s: { state: string }) => void }} h
 * @param {{ joinWithCode: Function, shellDeviceKey: Function, invoke: Function, relay: string, name?: string }} deps
 * @returns {Promise<{ ok: true } | { ok: false, say: string }>}
 */
export async function startTypedPairing(h, deps) {
  const r = await deps.joinWithCode({
    relay: deps.relay, input: h.input, name: deps.name || "this computer",
    onState: (s) => { if (s.state === "ack" && s.code && h.onAck) h.onAck(s.code); else if (h.onState) h.onState(s); },
    pairOptions: { about: { kind: "app" }, ...deps.shellDeviceKey(deps.invoke) },
  });
  if (!r.ok) return { ok: false, say: SAY[r.reason] || SAY.refused };
  const link = r.paired;
  if (!link || typeof link.address !== "string") return { ok: false, say: SAY.nothing };
  try { await deps.invoke("finish_typed_pair", { link, address: link.address }); }
  catch (e) { return { ok: false, say: String((e && e.message) || e) }; }
  return { ok: true };
}
