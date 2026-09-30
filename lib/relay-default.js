// @ts-check
// lib/relay-default: the one shared relay address, wss://relay.vyre.run, every box registers
// through by default. A pure constant, no feature state, so both core/relay (which settings()
// falls back to) and core/daemon (which needs it to build the Deck's CSP connect-src for Wink,
// ADR 0045, without importing the whole relay module into the kernel - reviewer's MEDIUM,
// 2026-09-28) can import it without creating a kernel -> feature edge.

export const DEFAULT_RELAY = "wss://relay.vyre.run";
