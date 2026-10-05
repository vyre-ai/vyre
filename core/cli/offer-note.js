// @ts-check
// What a person is told after the CLI shows a phone's typed code (wink.phone.open): the phone types it, then shows a code of its own, and the person types THAT here. The typed-back ack is the owner's yes that
// confirms the device (0.2.9, one way to pair: the relay's old offer, whose redemption confirmed nothing, is gone from `vyre phone`, `vyre relay pair` and onboarding).
export const ACK_NOTE = "On the phone, type this code in the Vyre app (Devices, Add a device). It then shows a code of its own: type that here with `vyre wink ack <code>`.";
