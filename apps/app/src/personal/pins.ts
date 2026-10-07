// The servers this person said yes to, as this phone remembers them: each server's fingerprint and public key (public values, so the view cache is the right place). The phone answers only a server pinned here.
import { viewCache } from "../state/cache";

const KEY = "personal-grants";
type Jwk = { x: string; y: string };

const read = async (): Promise<Record<string, Jwk>> => {
  const v = await viewCache.get<Record<string, Jwk>>(KEY);
  return v && typeof v === "object" ? v : {};
};

export const pins = {
  async all(): Promise<Map<string, Jwk>> { return new Map(Object.entries(await read())); },
  async set(fp: string, jwk: Jwk): Promise<void> { await viewCache.set(KEY, { ...(await read()), [fp]: { x: jwk.x, y: jwk.y } }); },
  async delete(fp: string): Promise<void> { const m = await read(); delete m[fp]; await viewCache.set(KEY, m); },
};
