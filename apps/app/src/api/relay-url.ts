// The relay a device with no box of its own types a short Wink code at. The Vyre relay unless a build says otherwise (EXPO_PUBLIC_VYRE_RELAY, read as process.env.NAME exactly: Expo inlines only that form).
export const relayUrl = (): string => (process.env.EXPO_PUBLIC_VYRE_RELAY || "wss://relay.vyre.run").replace(/\/+$/, "");
