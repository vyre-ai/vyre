// Devices and access, sample data (public sample world). `loadAccess()` is the one read; a real source replaces it.
import type { AvatarFamily } from "@vyre/ui";

export type AccessKind = "Device" | "Person" | "Assistant" | "Kit" | "Flow";
export type AccessItem = {
  id: string; kind: AccessKind; name: string; allows: string; since: string; last: string;
  /** Devices only: phone, computer or server. */
  device?: "phone" | "computer" | "server";
  family: AvatarFamily;
};
export const SPACE_NAMES: Record<string, string> = { mine: "Mine", harlow: "Harlow Legal" };

export function loadAccess(): AccessItem[] {
  return [
    { id: "d1", kind: "Device", device: "computer", family: "device", name: "Alex's Mac", allows: "Opens your projects and your vault, and uses your computers.", since: "12 Aug", last: "Now" },
    { id: "d2", kind: "Device", device: "phone", family: "device", name: "Alex's iPhone", allows: "Does everything you can, until you remove it. Face ID approves each send and payment.", since: "12 Aug", last: "2 min ago" },
    { id: "d3", kind: "Device", device: "server", family: "device", name: "nova", allows: "Runs your spaces and keeps working when your computer sleeps.", since: "21 Aug", last: "Now" },
    { id: "p1", kind: "Person", family: "person", name: "Chris Park", allows: "Owner of Harlow Legal. Reads and adds to Intake and Billing.", since: "20 Aug", last: "Today" },
    { id: "p2", kind: "Person", family: "person", name: "Dana Reyes", allows: "Temp on Harlow Legal. Reads one project.", since: "3 Sep", last: "Yesterday" },
    { id: "a1", kind: "Assistant", family: "assistant", name: "juno", allows: "Your assistant. Reads what you can. Cannot send, pay or read the Vault without asking.", since: "12 Aug", last: "Now" },
    { id: "a2", kind: "Assistant", family: "teammate", name: "kit", allows: "Works on Harlow Legal projects as you, on your Claude account.", since: "14 Aug", last: "12 min ago" },
    { id: "a3", kind: "Assistant", family: "agent", name: "@Engineer", allows: "Admins only. Changes definitions in Harlow Legal. Cannot send, pay or read the Vault.", since: "1 Oct", last: "Today" },
    { id: "k1", kind: "Kit", family: "project", name: "Estate planning matter", allows: "Adds 2 record types, 3 Flows, 4 views and 1 role to Harlow Legal.", since: "3 Sep", last: "Today" },
    { id: "f1", kind: "Flow", family: "project", name: "On payment", allows: "Makes a project from the Estate planning matter Kit when a client pays. Sends nothing without a check.", since: "3 Sep", last: "Today 9:12" },
  ];
}

/** Which spaces each device is in. Each device joins each space on its own. */
export function loadDeviceSpaces(): Record<string, string[]> {
  return { d1: ["mine", "harlow"], d2: ["mine", "harlow"], d3: ["mine"] };
}

export function loadLend() {
  return { spaceId: "harlow", spaceAllows: true, allowedBy: "Chris, 30 Sep", limits: "Only when it is idle, within 4 GB and 2 sessions. It runs Harlow Legal's work and nothing of yours." };
}

export const ACCESS_FILTERS: [string, string][] = [["all", "All"], ["Device", "Devices"], ["Person", "People"], ["Assistant", "Assistants"], ["Kit", "Kits"], ["Flow", "Flows"]];

/** The glyph for a device or a thing that is not a who. */
export function glyph(a: Pick<AccessItem, "kind" | "device">): "phone" | "box" | "laptop" | "planner" | undefined {
  if (a.kind === "Device") return a.device === "phone" ? "phone" : a.device === "server" ? "box" : "laptop";
  if (a.kind === "Kit") return "box";
  if (a.kind === "Flow") return "planner";
  return undefined;
}
