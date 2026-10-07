// Spaces and members, sample data (public sample world). `loadSpaces()` and `loadMembers()` are the reads; a real source replaces them.
import type { Role } from "./roles.js";

export type SpaceCard = { id: string; name: string; address: string; role: string; home: string; setup?: { step: string; device: { id: string; name: string }; [k: string]: unknown } | null };
export type Member = { id: string; name: string; sub?: string; role: Role; scope?: string; end?: string; left?: number };
export type Teammate = { id: string; name: string; sub: string };

export function loadSpaces(): SpaceCard[] {
  return [
    { id: "mine", name: "Mine", address: "alex.vyre.run", role: "owner", home: "this computer" },
    { id: "juniper", name: "Juniper Studio", address: "juniper.vyre.run", role: "admin", home: "your server" },
  ];
}

export function loadMembers(): Member[] {
  return [
    { id: "chris", name: "Chris Park", role: "owner" },
    { id: "alex", name: "Alex Rivera", role: "admin" },
    { id: "mei", name: "Mei Tanaka", role: "manager" },
    { id: "ben", name: "Ben Okafor", role: "member" },
    { id: "dana", name: "Dana Reyes", role: "temp", scope: "Doe estate plan", end: "14 Oct", left: 11 },
    { id: "marco", name: "Marco Doe", role: "temp", scope: "Ortiz power of attorney", end: "6 Oct", left: 3 },
  ];
}

export function loadTeammates(): Teammate[] {
  return [{ id: "kit", name: "kit", sub: "Assistant, works as Alex" }];
}

export const TEMP_PROJECTS = ["Doe estate plan", "Ortiz power of attorney", "Site rebuild"];
export const ME = "alex";
