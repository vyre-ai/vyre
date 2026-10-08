// @ts-check
// The mark a registry puts on ONE tool call whose outward card the person approved and the registry has just redeemed: { card, tool, input_sha256, asker }. It is a Symbol-keyed property of the call's meta,
// so it is never in anything a client or a module sends (JSON has no symbols), is not enumerated by JSON.stringify, and goes only where the registry hands the running call's meta on to a module the
// call itself makes. It is NOT the authority: the Gate asks the approvals queue whether that card was redeemed for exactly this tool, input and asker, within its life, and not yet used (approvals.cover).
export const COVERED = Symbol("vyre.covered-by-card");
