import { useEffect, useMemo, useState } from "react";
import { RolePicker } from "@vyre/ui";
import { MOCK } from "../../src/real/box";
import { useMembers } from "../spaces/state";
import { TEMP_DAYS } from "../devices/invite.js";
import { builtInRoles, inviteChoices, type Role } from "./roles";
import { source } from "./state";
import { MOCK_PROJECTS } from "./mock.js";

/**
 * The invite step's role choice, shared by Settings' invite and the onboarding Invite screen: the roles the person may give (built-ins and the space's own), with the
 * projects to add them to and, for a Guest, when it ends. `role` is what the box is sent; Guest is "temp". Reads the space's roles itself and falls back to the built-ins
 * when the box does not list roles.
 */
export function InviteRolePicker({ actor, role, onRole, projects, onProjects, days, onDays }: {
  actor: string | undefined; role: string; onRole: (id: string) => void; projects: string[]; onProjects: (ids: string[]) => void; days: string; onDays: (v: string) => void;
}) {
  const [roles, setRoles] = useState<Role[]>(() => builtInRoles());
  const [known, setKnown] = useState<{ id: string; name: string }[]>(MOCK ? MOCK_PROJECTS : []);
  const spaceProjects = useMembers((s) => s.projects);
  useEffect(() => { let live = true; void source().read().then((w) => { if (live) { setRoles(w.roles); if (w.projects.length) setKnown(w.projects); } }).catch(() => {}); return () => { live = false; }; }, []);
  const list = MOCK ? known : spaceProjects.length ? spaceProjects : known;
  const names = useMemo(() => Object.fromEntries(list.map((p) => [p.id, p.name])), [list]);
  const choices = useMemo(() => inviteChoices(actor, roles, names), [actor, roles, names]);
  useEffect(() => { if (choices.length && !choices.some((c) => c.id === role)) onRole(choices.find((c) => c.id === "member")?.id ?? choices[0].id); }, [choices, role]);
  return <RolePicker roles={choices} value={role} onChange={onRole} projects={list} chosen={projects} onChosen={onProjects} guest="temp" ends={days} onEnds={onDays} endOptions={TEMP_DAYS as [string, string][]} />;
}
