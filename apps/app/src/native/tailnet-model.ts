// The slot for tailnet's embedded connection (pure). When the app can run the tailnet client
// itself, it reaches the box directly over the person's private network. Until then, and on the
// web, the null link says "off" and the app uses the relay path (src/api/relay.*), which works on
// its own. Nothing here knows how a link is made; a real one implements EmbeddedLink.

export type LinkConfig = {
  /** The coordination server for the person's network (their own Headscale or the default). */
  control: string;
  /** This device's name on the network. */
  hostname: string;
  /** A one-time key to join, when the network needs one. Never logged or stored by the slot. */
  authKey?: string;
};

export type LinkState = "off" | "starting" | "up" | "failed";

export type LinkStatus = {
  state: LinkState;
  /** This device's address on the network, once up. */
  address?: string;
  /** One plain sentence for the screen. */
  say: string;
};

export interface EmbeddedLink {
  start(config: LinkConfig): Promise<LinkStatus>;
  stop(): Promise<void>;
  status(): LinkStatus;
}

export type Path = "tailnet" | "relay" | "direct";

export const OFF: LinkStatus = { state: "off", say: "The app is not running its own private-network link. It uses the relay." };

/** The link when none is built in: starts nothing, stays off. */
export const nullLink: EmbeddedLink = {
  async start() {
    return OFF;
  },
  async stop() {},
  status: () => OFF,
};

/**
 * Which way the app reaches the box: the embedded link when it is up, else the relay when the
 * device is paired through it, else the box's own address.
 */
export function pickPath(o: { link: LinkStatus; relayPaired: boolean }): Path {
  if (o.link.state === "up") return "tailnet";
  return o.relayPaired ? "relay" : "direct";
}
