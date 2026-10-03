// The embedded tailnet link slot on the phone. No native tailnet client is built in yet, so this
// is the null link: the app reaches the box over the relay (src/api/relay.native.ts). A real link
// replaces `link` through setLink() when tailnet's native module lands.

import { nullLink, type EmbeddedLink } from "./tailnet-model.ts";

export type { EmbeddedLink, LinkConfig, LinkState, LinkStatus, Path } from "./tailnet-model.ts";
export { nullLink, pickPath, OFF } from "./tailnet-model.ts";

let current: EmbeddedLink = nullLink;
export const link = (): EmbeddedLink => current;
export const setLink = (l: EmbeddedLink) => void (current = l);
