import { create } from "zustand";
import { loadMembers, type Member } from "./data";
import { extend, withRole, type Role } from "./roles.js";

type S = {
  members: Member[];
  setRole: (id: string, role: Role, opts?: { scope?: string; days?: number }) => void;
  remove: (id: string) => void;
  extendBy: (id: string, days: number) => void;
  addTemp: (m: Member) => void;
};

export const useMembers = create<S>((set) => ({
  members: loadMembers(),
  setRole: (id, role, opts) => set((s) => ({ members: s.members.map((m) => (m.id === id ? (withRole(m, role, opts) as Member) : m)) })),
  remove: (id) => set((s) => ({ members: s.members.filter((m) => m.id !== id) })),
  extendBy: (id, days) => set((s) => ({ members: s.members.map((m) => (m.id === id ? (extend(m, days) as Member) : m)) })),
  addTemp: (m) => set((s) => ({ members: [...s.members, m] })),
}));
