import { create } from "zustand";
import { MOCK, said, tool } from "../../src/real/box";
import { loadMembers, loadSpaces, type Member, type SpaceCard } from "./data";
import { extend, withRole, type Role } from "./roles.js";
import { extendedTo, setRoleInput, roleNames, shapeMembers, shapeProjects, shapeSpaces, warningLines } from "./real.js";

type Opts = { scope?: string; days?: number };

type S = {
  spaces: SpaceCard[];
  members: Member[];
  /** Real projects a temp member can be limited to: id and name. */
  projects: { id: string; name: string }[];
  roleNames: Record<string, string>;
  warnings: string[];
  /** This device's identity id and device entry id, from spaces.identity.status. */
  selfId: string | null;
  deviceId: string | null;
  /** The space whose members are shown. */
  space: string | null;
  loading: boolean;
  error: string | null;
  load: (space?: string | null) => Promise<void>;
  setRole: (id: string, role: Role, opts?: Opts) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  extendBy: (id: string, days: number) => Promise<string | null>;
  addTemp: (m: Member & { person?: string }) => Promise<string | null>;
};

const mockOn = MOCK;

export const useMembers = create<S>((set, get) => {
  /** Run a write; on failure keep the words, on success reload. Returns the error words or null. */
  const write = async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    try {
      await tool(name, input);
      await get().load(get().space);
      return null;
    } catch (e) {
      const m = said(e);
      set({ error: m });
      return m;
    }
  };
  const spaceId = () => get().space;
  const projectId = (name?: string) => get().projects.find((p) => p.name === name || p.id === name)?.id;
  return {
    spaces: mockOn ? loadSpaces() : [],
    members: mockOn ? loadMembers() : [],
    projects: [],
    roleNames: {},
    warnings: [],
    selfId: null,
    deviceId: null,
    space: null,
    loading: !mockOn,
    error: null,
    async load(want) {
      if (mockOn) return;
      set({ loading: true });
      try {
        const [list, me] = await Promise.all([tool("spaces.list"), tool<any>("spaces.identity.status").catch(() => null)]);
        const spaces = shapeSpaces(list);
        const space = spaces.find((s) => s.id === want)?.id ?? spaces.find((s) => s.id === get().space)?.id ?? spaces[0]?.id ?? null;
        const selfId = me?.id ?? null;
        set({ spaces, space, selfId, deviceId: me?.eid ?? null });
        if (!space) { set({ members: [], warnings: [], error: null, loading: false }); return; }
        const [mem, names, projects] = await Promise.all([
          tool("spaces.members.list", { space }),
          tool("spaces.roles.names", { space }).catch(() => null),
          tool("projects.list").catch(() => null),
        ]);
        const proj = shapeProjects(projects);
        set({
          members: shapeMembers(mem, selfId, Date.now(), Object.fromEntries(proj.map((p) => [p.id, p.name]))) as Member[],
          projects: proj,
          roleNames: roleNames(names),
          warnings: warningLines(mem),
          error: null,
          loading: false,
        });
      } catch (e) {
        set({ error: said(e), loading: false });
      }
    },
    async setRole(id, role, opts) {
      if (mockOn) { set((s) => ({ members: s.members.map((m) => (m.id === id ? (withRole(m, role, opts) as Member) : m)) })); return null; }
      const scope = opts?.scope ? [projectId(opts.scope) ?? opts.scope] : undefined;
      return write("spaces.members.set-role", setRoleInput(spaceId()!, id, role, { scope, days: opts?.days }, Date.now()));
    },
    async remove(id) {
      if (mockOn) { set((s) => ({ members: s.members.filter((m) => m.id !== id) })); return null; }
      return write("spaces.members.remove", { space: spaceId(), person: id });
    },
    async extendBy(id, days) {
      if (mockOn) { set((s) => ({ members: s.members.map((m) => (m.id === id ? (extend(m, days) as Member) : m)) })); return null; }
      const m = get().members.find((x) => x.id === id);
      const current = m?.end && m.left !== undefined ? Date.now() + m.left * 86_400_000 : null;
      return write("spaces.members.extend", { space: spaceId(), person: id, expires: extendedTo(current, days, Date.now()) });
    },
    async addTemp(m) {
      if (mockOn) { set((s) => ({ members: [...s.members, m] })); return null; }
      const scope = m.scope ? [projectId(m.scope) ?? m.scope] : [];
      return write("spaces.members.add", { space: spaceId(), person: m.person ?? m.name, role: "temp", scope, expires: Date.now() + (m.left ?? 7) * 86_400_000 });
    },
  };
});
