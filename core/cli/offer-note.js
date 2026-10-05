// @ts-check
// What a person is told after a pairing made by the relay's offer (`relay.pair.start`, the QR or link `vyre phone` and `vyre relay pair` show): that way of pairing has no owner confirmation, so the device
// is paired but cannot sign in as the person until they confirm it from Devices. The typed code (wink.phone.open) confirms the device itself. 0.3.1 moves these commands to the typed code (team/BACKLOG.md).
export const OFFER_NOTE = "This device can't sign in as you until you confirm it from Devices.";
