import { Redirect, useLocalSearchParams } from "expo-router";
import { aliasOf } from "./route-aliases.js";

/** A route that only sends an old address to its one name. `from` is the pattern, and each `:param` is filled from the URL. */
export function AliasRoute({ from }: { from: string }) {
  const params = useLocalSearchParams();
  const path = from.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const v = params[key];
    const s = Array.isArray(v) ? v[0] : v;
    return encodeURIComponent(String(s ?? ""));
  });
  const hit = aliasOf(path);
  return <Redirect href={(hit?.to ?? "/u/now") as never} />;
}
