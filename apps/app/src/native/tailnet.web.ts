// The web build of tailnet.ts: a browser cannot run a tailnet client. It reaches the box directly
// (at the box's own address) or through the relay, so the link stays off.

import { nullLink, type EmbeddedLink } from "./tailnet-model.ts";

export type { EmbeddedLink, LinkConfig, LinkState, LinkStatus, Path } from "./tailnet-model.ts";
export { nullLink, pickPath, OFF } from "./tailnet-model.ts";

export const link = (): EmbeddedLink => nullLink;
export const setLink = (_l: EmbeddedLink) => {};
