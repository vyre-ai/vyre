// Settings, First page for each role: the page each role opens on when they sign in to this Space.
// The value is the setting spaces.landing (the settings hub keeps it, at account level): a route per
// role, and a role with no route of its own opens Home. The roles come from the box (roles.catalogue),
// so the app carries no role list of its own.
import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Card, Divider, ErrorState, LoadingState, Row, Select, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { PLACES, moduleHref } from "../../../../lib/sidebar/model.js";
import { keys } from "./keys";
import { refusal } from "./keys-model.ts";
import { tool } from "../../src/real/box";

/** The setting key the spaces module owns. */
const KEY = "spaces.landing";

/** The page a role opens on when nothing is set for it. */
const HOME = "/u/now";

/** The Space's own screens are views of the module "space", so the app draws them itself. */
const SPACE = "space";

/** A role as the box names it for a person. */
type Role = { id: string; label: string; description?: string };

/** Settings, First page for each role: one picker per role, and the pages a role may open on. */
export function LandingScreen() {
  const [value, setValue] = useState<Record<string, string> | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [screens, setScreens] = useState<{ id: string; title: string }[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    Promise.all([
      keys.one(KEY),
      tool<{ builtin?: Role[] }>("roles.catalogue", {}).catch(() => null),
      tool<{ screens?: { id: string; title: string }[] }>("design.screens", {}).catch(() => null),
    ])
      .then(([k, r, s]) => {
        setValue(k && k.value && typeof k.value === "object" && !Array.isArray(k.value) ? (k.value as Record<string, string>) : {});
        setRoles(Array.isArray(r?.builtin) ? r.builtin : []);
        setScreens(Array.isArray(s?.screens) ? s.screens : []);
      })
      .catch((e) => setErr(refusal(e)));
  }, []);
  useEffect(load, [load]);
  /** The pages a role may open on: the built-in places, then the Space's own screens. */
  const options = useMemo<[string, string][]>(() => [
    ...PLACES.map((p) => [p.href, p.label] as [string, string]),
    ...screens.filter((s) => typeof s.id === "string" && s.id).map((s) => [moduleHref(SPACE, s.id), s.title || s.id] as [string, string]),
  ], [screens]);
  /** One role's page, saved for the whole Space. */
  const choose = (role: string, route: string) => {
    const before = value || {};
    const next = { ...before, [role]: route };
    setValue(next);
    keys.set(KEY, next).then((r) => { if (r && r.value && typeof r.value === "object") setValue(r.value as Record<string, string>); }).catch((e) => { setValue(before); showToast(`Not saved. ${refusal(e)}`); });
  };
  return (
    <Page title="First page for each role" sub="The page each role opens on when they sign in to this Space. A role with no page of its own opens Home." back="/u/settings">
      <Banner>Everyone in this Space opens the page set for their role. You can change it at any time.</Banner>
      {err ? <Card flush><ErrorState title="This did not load" reason={err} retry={load} /></Card> : null}
      {!value && !err ? <LoadingState rows={4} /> : null}
      {value && roles.length ? (
        <Card flush>
          {roles.map((role, i) => (
            <View key={role.id}>
              {i ? <Divider /> : null}
              <View className="gap-s2 p-s3">
                <Row title={role.label} sub={role.description} />
                <Select label={`${role.label} opens`} value={value[role.id] || HOME} options={options} onChange={(v) => choose(role.id, v)} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {value && !roles.length ? <Text size="caption" tone="label">There are no roles to set a page for here.</Text> : null}
    </Page>
  );
}
