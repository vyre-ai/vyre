// @ts-check
// pair: the page at vyre.run/pair that the old pairing QR opened. That code is gone: the box no longer
// makes or accepts it. The page says so and names the next step. It makes no request and reads nothing
// from the address.

export const GONE = "That is an old kind of pairing code that no longer works. Sign in on the device with your space address, your username and your master password.";

if (typeof document !== "undefined") {
  const about = document.getElementById("about");
  if (about) about.textContent = GONE;
}
