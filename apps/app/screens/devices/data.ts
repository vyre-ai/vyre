// Devices and access, sample data (public sample world). `loadAccess()` is the one read; a real source replaces it.
import type { AvatarFamily } from "@vyre/ui";

export type AccessKind = "Device" | "Person" | "Assistant" | "Kit" | "Flow";
export type AccessItem = {
  id: string; kind: AccessKind; name: string; allows: string; since: string; last: string;
  /** Devices only: phone, computer or server. */
  device?: "phone" | "computer" | "server";
  /** Devices only: the key that signs for this device is kept in software, not in secure hardware (the vault's paired session reports it; tailnet provides the field). */
  software?: boolean;
  family: AvatarFamily;
};
export const SPACE_NAMES: Record<string, string> = { mine: "Mine", juniper: "Juniper Studio" };

export function loadAccess(): AccessItem[] {
  return [
    { id: "d1", kind: "Device", device: "computer", family: "device", name: "Alex's Mac", allows: "Opens your projects and your vault, and uses your computers.", since: "12 Aug", last: "Now" },
    { id: "d2", kind: "Device", device: "phone", family: "device", name: "Alex's iPhone", allows: "Does everything you can, until you remove it. Face ID approves each send and payment.", since: "12 Aug", last: "2 min ago" },
    { id: "d3", kind: "Device", device: "server", family: "device", name: "nova", software: true, allows: "Runs your spaces and keeps working when your computer sleeps.", since: "21 Aug", last: "Now" },
    { id: "p1", kind: "Person", family: "person", name: "Chris Park", allows: "Owner of Juniper Studio. Reads and adds to Intake and Billing.", since: "20 Aug", last: "Today" },
    { id: "p2", kind: "Person", family: "person", name: "Dana Reyes", allows: "Temp on Juniper Studio. Reads one project.", since: "3 Sep", last: "Yesterday" },
    { id: "a1", kind: "Assistant", family: "assistant", name: "juno", allows: "Your assistant. Reads what you can. Cannot send, pay or read the Vault without asking.", since: "12 Aug", last: "Now" },
    { id: "a2", kind: "Assistant", family: "teammate", name: "kit", allows: "Works on Juniper Studio projects as you, on your Claude account.", since: "14 Aug", last: "12 min ago" },
    { id: "a3", kind: "Assistant", family: "agent", name: "@Engineer", allows: "Admins only. Changes definitions in Juniper Studio. Cannot send, pay or read the Vault.", since: "1 Oct", last: "Today" },
    { id: "k1", kind: "Kit", family: "project", name: "Estate planning matter", allows: "Adds 2 record types, 3 Flows, 4 views and 1 role to Juniper Studio.", since: "3 Sep", last: "Today" },
    { id: "f1", kind: "Flow", family: "project", name: "On payment", allows: "Makes a project from the Estate planning matter Kit when a client pays. Sends nothing without a check.", since: "3 Sep", last: "Today 9:12" },
  ];
}

/** Which spaces each device is in. Each device joins each space on its own. */
export function loadDeviceSpaces(): Record<string, string[]> {
  return { d1: ["mine", "juniper"], d2: ["mine", "juniper"], d3: ["mine"] };
}

export function loadLend() {
  return { spaceId: "juniper", spaceAllows: true, allowedBy: "Chris, 30 Sep", limits: "Only when it is idle, within 4 GB and 2 chats. It runs Juniper Studio's work and nothing of yours." };
}

export const ACCESS_FILTERS: [string, string][] = [["all", "All"], ["Device", "Devices"], ["Person", "People"], ["Assistant", "Assistants"], ["Kit", "Kits"], ["Flow", "Flows"]];

/** The glyph for a device or a thing that is not a who. */
export function glyph(a: Pick<AccessItem, "kind" | "device">): "phone" | "box" | "laptop" | "planner" | undefined {
  if (a.kind === "Device") return a.device === "phone" ? "phone" : a.device === "server" ? "box" : "laptop";
  if (a.kind === "Kit") return "box";
  if (a.kind === "Flow") return "planner";
  return undefined;
}
